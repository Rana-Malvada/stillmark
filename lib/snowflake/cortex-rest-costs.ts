import { randomUUID } from 'node:crypto'
import { pgIndependent } from '../postgres'
import { costContext } from '../costs/cost-context'

// Snowflake Service Consumption Table, effective 2026-10-15, table 6(b).
// https://www.snowflake.com/legal-files/CreditConsumptionTable.pdf
export const REST_PRICING_VERSION = '2026-10-15-table-6b'
export function restCredits(
  model: string,
  usage: Record<string, unknown> | undefined,
): number | null {
  const rates: Record<string, [number, number, number]> = {
    'claude-haiku-4-5': [0.5, 2.5, 0.05],
    'claude-sonnet-4-6': [1.5, 7.5, 0.15],
  }
  const rate = rates[model]
  if (!rate || !usage) return null
  const input = usage.input_tokens
  const output = usage.output_tokens
  const read = usage.cache_read_input_tokens ?? 0
  const write = usage.cache_creation_input_tokens ?? 0
  if (
    ![input, output, read, write].every(
      (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0,
    )
  )
    return null
  // We do not request caching. Unknown cache-write durations must not be guessed.
  if (write !== 0) return null
  // Global inference estimates, in credits per million tokens. Account usage is reconciled separately.
  return (
    ((input as number) * rate[0] + (output as number) * rate[1] + (read as number) * rate[2]) / 1e6
  )
}
// OpenAI list prices in USD per million tokens (input, output), read 2026-11-23 from
// https://developers.openai.com/api/docs/models. Reasoning tokens are billed as output
// and are already inside output_tokens. These requests are not Snowflake usage: they
// are never converted to credits and never reconciled against Snowflake's records.
export const OPENAI_PRICING_VERSION = 'openai-usd-2026-11-23'
export const OPENAI_RATES: Record<string, [number, number]> = {
  'gpt-6.2-astra': [8, 40],
  'gpt-6.2-sol': [2, 10],
  'gpt-6.1-terra': [1, 5],
  'gpt-6-luna': [0.1, 0.5],
}
/** Cached input is charged at the full input rate here, so the estimate never understates. */
export function openAiUsd(model: string, usage: Record<string, unknown> | undefined) {
  const rate = OPENAI_RATES[model]
  if (!rate || !usage) return null
  const { input_tokens: input, output_tokens: output } = usage
  if (![input, output].every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0))
    return null
  return ((input as number) * rate[0] + (output as number) * rate[1]) / 1e6
}
export async function beginRestCost(model: string, pricingVersion = REST_PRICING_VERSION) {
  const workId = costContext.getStore()
  if (!workId) throw Error('Photo AI cost attribution context is missing')
  const id = randomUUID()
  await pgIndependent(
    'INSERT INTO cost_rest_requests(id,work_id,model,pricing_version) VALUES($1,$2,$3,$4)',
    [id, workId, model, pricingVersion],
  )
  return id
}
export async function finishRestCost(
  id: string,
  model: string,
  usage?: Record<string, unknown>,
  requestId?: string | null,
) {
  // Explicit allowlist: provider response content is never written to the ledger.
  const counts = usage
    ? Object.fromEntries(
        ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
          .filter((k) => typeof usage[k] === 'number')
          .map((k) => [k, usage[k]]),
      )
    : null
  if (model in OPENAI_RATES) {
    const usd = openAiUsd(model, usage)
    await pgIndependent(
      'UPDATE cost_rest_requests SET status=$2,provider_request_id=$3,usage=$4::jsonb,estimated_credits=NULL WHERE id=$1',
      [
        id,
        usd === null ? 'unavailable' : 'reported',
        typeof requestId === 'string' ? requestId.slice(0, 256) || null : null,
        counts ? JSON.stringify(usd === null ? counts : { ...counts, estimated_usd: usd }) : null,
      ],
    )
    return
  }
  const credits = restCredits(model, usage)
  await pgIndependent(
    'UPDATE cost_rest_requests SET status=$2,provider_request_id=$3,usage=$4::jsonb,estimated_credits=$5 WHERE id=$1',
    [
      id,
      credits === null ? 'unavailable' : 'reported',
      typeof requestId === 'string' ? requestId.slice(0, 256) || null : null,
      counts ? JSON.stringify(counts) : null,
      credits,
    ],
  )
}

/** Agents can invoke multiple models and add cached orchestration context.
 * Preserve each reported model's counts, but never apply Messages rates to them.
 * Credits remain unavailable until Agents billing is reconciled.
 */
export async function finishAgentCost(id: string, usage: unknown, requestId?: string | null) {
  const counts = Array.isArray(usage)
    ? usage.map((entry) => {
        const clean: Record<string, unknown> = {}
        if (!entry || typeof entry !== 'object') return clean
        for (const key of ['model_name', 'model_role']) {
          if (typeof entry[key] === 'string') clean[key] = entry[key].slice(0, 256)
        }
        for (const key of ['input_tokens', 'output_tokens']) {
          const tokens = entry[key]
          if (!tokens || typeof tokens !== 'object') continue
          clean[key] = Object.fromEntries(
            ['total', 'uncached', 'cache_read', 'cache_write']
              .filter((k) => Number.isSafeInteger(tokens[k]) && tokens[k] >= 0)
              .map((k) => [k, tokens[k]]),
          )
        }
        return clean
      })
    : null
  await pgIndependent(
    'UPDATE cost_rest_requests SET status=$2,provider_request_id=$3,usage=$4::jsonb,estimated_credits=NULL WHERE id=$1',
    [
      id,
      'unavailable',
      typeof requestId === 'string' ? requestId.slice(0, 256) || null : null,
      counts ? JSON.stringify({ transport: 'agents', tokens_consumed: counts }) : null,
    ],
  )
}
