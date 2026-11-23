import { prunePhotoInferenceReceipts } from './photo-inference-retention'
import { pgIndependent } from '../postgres'
import { finishRestCost } from '../snowflake/cortex-rest-costs'

export interface InferenceReceipt {
  text: string
  costId: string
  model: string
  usage?: Record<string, unknown>
  requestId?: string | null
}
export interface InferenceHooks {
  dispatched: (costId: string) => Promise<void>
  rateLimited: () => Promise<void>
  received: (receipt: InferenceReceipt) => Promise<void>
}
export class InferenceOutcomeUnknown extends Error {
  constructor() {
    super(
      'AI request outcome is uncertain. Automatic retry stopped to avoid a duplicate charge; review this photo before retrying.',
    )
  }
}
type Row = {
  id: string
  photo_id: number
  prompt_version: string
  source_path: string
  state: string
  cost_id: string
  model: string
  result: string
  usage: Record<string, unknown>
  provider_request_id: string
}
async function settle(row: Row) {
  await finishRestCost(row.cost_id, row.model, row.usage, row.provider_request_id)
  await pgIndependent(
    `UPDATE photo_inference_receipts SET ledger_done=true WHERE id=$1 AND cost_id=$2 AND state='received'`,
    [row.id, row.cost_id],
  )
}
/** Durable receipt before ledger completion or catalog publication. Never infer again
 * after an ambiguous dispatch. The worker's photo claim still fences publication. */
export async function recoverPhotoInference(
  photoId: number,
  version: string,
  path: string,
  work: (hooks: InferenceHooks) => Promise<string>,
) {
  const key = [photoId, version, path]
  await pgIndependent(
    'INSERT INTO photo_inference_receipts(photo_id,prompt_version,source_path) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    key,
  )
  const [row] = await pgIndependent<Row>(
    'SELECT * FROM photo_inference_receipts WHERE photo_id=$1 AND prompt_version=$2 AND source_path=$3 AND NOT retired',
    key,
  )
  if (!row) throw Error('Photo inference receipt is unavailable')
  if (row.state === 'received') {
    await settle(row).catch(() => console.warn('[photo-ai-ledger]'))
    return row.result
  }
  if (row.state !== 'prepared') throw new InferenceOutcomeUnknown()
  let dispatched = false
  let dispatchCostId: string | undefined
  try {
    return await work({
      dispatched: async (costId) => {
        const rows = await pgIndependent(
          `UPDATE photo_inference_receipts SET state='dispatched',cost_id=$2,updated_at=now() WHERE id=$1 AND state='prepared' AND NOT retired RETURNING id`,
          [row.id, costId],
        )
        if (!rows.length) throw new InferenceOutcomeUnknown()
        dispatched = true
        dispatchCostId = costId
      },
      rateLimited: async () => {
        const rows = await pgIndependent(
          `UPDATE photo_inference_receipts SET state='prepared',cost_id=NULL,updated_at=now() WHERE id=$1 AND cost_id=$2 AND state='dispatched' AND NOT retired RETURNING id`,
          [row.id, dispatchCostId],
        )
        if (!rows.length) throw new InferenceOutcomeUnknown()
        dispatched = false
      },
      received: async (receipt) => {
        const usage = Object.fromEntries(
          Object.entries(receipt.usage ?? {}).filter(
            ([k, v]) =>
              [
                'input_tokens',
                'output_tokens',
                'cache_read_input_tokens',
                'cache_creation_input_tokens',
              ].includes(k) &&
              Number.isSafeInteger(v) &&
              Number(v) >= 0,
          ),
        )
        const rows = await pgIndependent(
          `UPDATE photo_inference_receipts SET state='received',result=$3,model=$4,usage=$5::jsonb,provider_request_id=$6,updated_at=now() WHERE id=$1 AND state='dispatched' AND cost_id=$2 RETURNING id`,
          [
            row.id,
            receipt.costId,
            receipt.text,
            receipt.model,
            JSON.stringify(usage),
            typeof receipt.requestId === 'string' ? receipt.requestId.slice(0, 256) : null,
          ],
        )
        if (!rows.length) throw new InferenceOutcomeUnknown()
      },
    })
  } catch (error) {
    if (dispatched) throw new InferenceOutcomeUnknown()
    throw error
  }
}
/** Bounded Postgres-only reconciliation; no provider request and no warehouse. */
export async function reconcilePhotoInferenceCosts() {
  const rows = await pgIndependent<Row>(
    "SELECT * FROM photo_inference_receipts WHERE state='received' AND NOT ledger_done ORDER BY updated_at LIMIT 20",
  )
  for (const row of rows) {
    try {
      await settle(row)
    } catch {
      console.warn('[photo-ai-ledger]')
      break
    }
  }
  await prunePhotoInferenceReceipts()
}
