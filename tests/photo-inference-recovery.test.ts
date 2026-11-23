import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as PGlite | null, finish: vi.fn(), failReceive: false }))
vi.mock('@/lib/postgres', () => ({
  pgIndependent: async (sql: string, args: unknown[] = []) => {
    if (state.failReceive && sql.includes("SET state='received'"))
      throw Error('receipt storage unavailable')
    return (await state.db!.query(sql, args)).rows
  },
}))
vi.mock('@/lib/snowflake/cortex-rest-costs', () => ({ finishRestCost: state.finish }))
import {
  reconcilePhotoInferenceCosts,
  recoverPhotoInference,
} from '@/lib/photos/photo-inference-recovery'

beforeAll(async () => {
  state.db = new PGlite()
  await state.db.exec(`CREATE ROLE personal_photos_maintenance; CREATE ROLE personal_photos_app;
  CREATE SCHEMA photo_security;
  CREATE FUNCTION photo_security.flag(text) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('photos.main_admin',true),'false')='true' $$;
  CREATE TABLE photos(photo_id int PRIMARY KEY,ai_attempts int DEFAULT 3,ai_error text,ai_next_attempt_at timestamptz,ai_description text,ai_lease_until timestamptz);
  GRANT USAGE ON SCHEMA photo_security TO personal_photos_app,personal_photos_maintenance;`)
  await state.db.exec(
    readFileSync('migrations/postgres/202610291910_photo_inference_receipts.sql', 'utf8'),
  )
  await state.db.exec(
    readFileSync('migrations/postgres/202610292100_photo_inference_retention.sql', 'utf8'),
  )
})
afterEach(() => vi.unstubAllEnvs())
afterAll(async () => {
  await state.db?.close()
})
beforeEach(async () => {
  state.failReceive = false
  state.finish.mockReset()
  await state.db!.exec(
    'RESET ROLE; TRUNCATE photo_inference_receipts,photos; INSERT INTO photos(photo_id) VALUES(1);',
  )
})
const receipt = {
  text: '{"description":"A mountain","tags":[]}',
  model: 'model',
  costId: '11111111-1111-4111-8111-111111111111',
  usage: { input_tokens: 100, output_tokens: 10 },
  requestId: 'provider-id',
}
it('recovers durable output after ledger or catalog failure without another provider call', async () => {
  const provider = vi.fn(async (hooks: any) => {
    await hooks.dispatched(receipt.costId)
    await hooks.received(receipt)
    return receipt.text
  })
  expect(await recoverPhotoInference(1, 'v1', 'display/1', provider)).toBe(receipt.text)
  state.finish.mockRejectedValueOnce(Error('ledger unavailable'))
  expect(await recoverPhotoInference(1, 'v1', 'display/1', provider)).toBe(receipt.text)
  expect(provider).toHaveBeenCalledTimes(1)
  await reconcilePhotoInferenceCosts()
  expect(state.finish).toHaveBeenLastCalledWith(
    receipt.costId,
    'model',
    receipt.usage,
    'provider-id',
  )
  expect((await state.db!.query('SELECT ledger_done FROM photo_inference_receipts')).rows).toEqual([
    { ledger_done: true },
  ])
})
it('does not redispatch an ambiguous request; explicit admin retry creates a new active receipt', async () => {
  const provider = vi.fn(async (hooks: any) => {
    await hooks.dispatched(receipt.costId)
    throw Error('connection reset')
  })
  await expect(recoverPhotoInference(1, 'v1', 'display/1', provider)).rejects.toThrow(
    'outcome is uncertain',
  )
  await expect(recoverPhotoInference(1, 'v1', 'display/1', provider)).rejects.toThrow(
    'outcome is uncertain',
  )
  expect(provider).toHaveBeenCalledTimes(1)
  await state.db!.exec('SET ROLE personal_photos_app')
  await expect(state.db!.query('SELECT photo_security.retry_photo_inference(1)')).rejects.toThrow(
    'Permission denied',
  )
  await expect(state.db!.query('SELECT * FROM photo_inference_receipts')).rejects.toThrow(
    'permission denied',
  )
  await state.db!.exec(
    "SELECT set_config('photos.main_admin','true',false); SELECT photo_security.retry_photo_inference(1); RESET ROLE; SELECT set_config('photos.main_admin','false',false);",
  )
  await expect(recoverPhotoInference(1, 'v1', 'display/1', provider)).rejects.toThrow(
    'outcome is uncertain',
  )
  expect(provider).toHaveBeenCalledTimes(2)
  expect(
    (await state.db!.query('SELECT count(*)::int n FROM photo_inference_receipts')).rows,
  ).toEqual([{ n: 2 }])
})
it('can settle retained usage even when the photo was deleted', async () => {
  await recoverPhotoInference(1, 'v1', 'display/1', async (hooks) => {
    await hooks.dispatched(receipt.costId)
    await hooks.received(receipt)
    return receipt.text
  })
  await state.db!.exec('DELETE FROM photos WHERE photo_id=1')
  await reconcilePhotoInferenceCosts()
  expect(
    (await state.db!.query('SELECT photo_id,ledger_done FROM photo_inference_receipts')).rows,
  ).toEqual([{ photo_id: null, ledger_done: true }])
})

it('permits recovery after an explicit rate-limit rejection but not an unknown dispatch', async () => {
  await expect(
    recoverPhotoInference(1, 'v1', 'display/1', async (hooks) => {
      await hooks.dispatched(receipt.costId)
      await hooks.rateLimited()
      throw Error('HTTP 429')
    }),
  ).rejects.toThrow('HTTP 429')
  const work = vi.fn(async (hooks: any) => {
    await hooks.dispatched(receipt.costId)
    await hooks.received(receipt)
    return receipt.text
  })
  expect(await recoverPhotoInference(1, 'v1', 'display/1', work)).toBe(receipt.text)
  expect(work).toHaveBeenCalledOnce()
})

it('does not repeat paid inference when storing its response fails', async () => {
  state.failReceive = true
  const provider = vi.fn(async (hooks: any) => {
    await hooks.dispatched(receipt.costId)
    await hooks.received(receipt)
    return receipt.text
  })
  await expect(recoverPhotoInference(1, 'v1', 'display/1', provider)).rejects.toThrow(
    'outcome is uncertain',
  )
  state.failReceive = false
  await expect(recoverPhotoInference(1, 'v1', 'display/1', provider)).rejects.toThrow(
    'outcome is uncertain',
  )
  expect(provider).toHaveBeenCalledOnce()
})

it('retains a late receipt for cost settlement after the photo is deleted during inference', async () => {
  await recoverPhotoInference(1, 'v1', 'display/1', async (hooks) => {
    await hooks.dispatched(receipt.costId)
    await state.db!.exec('DELETE FROM photos WHERE photo_id=1')
    await hooks.received(receipt)
    return receipt.text
  })
  await reconcilePhotoInferenceCosts()
  expect(
    (await state.db!.query('SELECT photo_id,ledger_done FROM photo_inference_receipts')).rows,
  ).toEqual([{ photo_id: null, ledger_done: true }])
})

it('a retired attempt cannot reset the replacement attempt after a delayed 429', async () => {
  let oldHooks: any
  await expect(
    recoverPhotoInference(1, 'v1', 'display/1', async (hooks) => {
      oldHooks = hooks
      await hooks.dispatched(receipt.costId)
      throw Error('timeout')
    }),
  ).rejects.toThrow('outcome is uncertain')
  await state.db!.exec(
    "SELECT set_config('photos.main_admin','true',false); SELECT photo_security.retry_photo_inference(1);",
  )
  const newCost = '22222222-2222-4222-8222-222222222222'
  await recoverPhotoInference(1, 'v1', 'display/1', async (hooks) => {
    await hooks.dispatched(newCost)
    await expect(oldHooks.rateLimited()).rejects.toThrow('outcome is uncertain')
    expect(
      (
        await state.db!.query(
          'SELECT state,cost_id FROM photo_inference_receipts WHERE NOT retired',
        )
      ).rows,
    ).toEqual([{ state: 'dispatched', cost_id: newCost }])
    // A late successful reply belongs to the retired receipt, for billing only.
    await oldHooks.received(receipt)
    await hooks.received({ ...receipt, costId: newCost, text: 'new result' })
    return 'new result'
  })
  const rows = (
    await state.db!.query('SELECT retired,result FROM photo_inference_receipts ORDER BY retired')
  ).rows
  expect(rows).toEqual([
    { retired: false, result: 'new result' },
    { retired: true, result: receipt.text },
  ])
})

it('prunes only old settled inactive receipts, in bounded idempotent batches', async () => {
  const { prunePhotoInferenceReceipts } = await import('@/lib/photos/photo-inference-retention')
  const db = state.db!
  await db.exec(`INSERT INTO photo_inference_receipts(photo_id,retired,prompt_version,source_path,state,ledger_done,updated_at)
    SELECT 1,true,'old-'||i,'display/1','received',true,now()-interval '100 days' FROM generate_series(1,205) i;
    INSERT INTO photo_inference_receipts(photo_id,retired,prompt_version,source_path,state,ledger_done,updated_at) VALUES
    (1,false,'active','display/1','received',true,now()-interval '100 days'),
    (1,true,'unsettled','display/1','received',false,now()-interval '100 days'),
    (1,true,'unknown','display/1','dispatched',false,now()-interval '100 days'),
    (1,true,'prepared','display/1','prepared',false,now()-interval '100 days'),
    (1,true,'recent','display/1','received',true,now()-interval '1 day'),
    (NULL,false,'orphan','display/1','received',true,now()-interval '100 days'),
    (NULL,false,'orphan-unsettled','display/1','received',false,now()-interval '100 days');
    SET ROLE personal_photos_maintenance;`)
  expect(await prunePhotoInferenceReceipts()).toBe(100)
  expect(await prunePhotoInferenceReceipts()).toBe(100)
  expect(await prunePhotoInferenceReceipts()).toBe(6)
  expect(await prunePhotoInferenceReceipts()).toBe(0)
  expect(
    (
      await db.query<{ prompt_version: string }>(
        'SELECT prompt_version FROM photo_inference_receipts ORDER BY prompt_version',
      )
    ).rows.map((row) => row.prompt_version),
  ).toEqual(['active', 'orphan-unsettled', 'prepared', 'recent', 'unknown', 'unsettled'])
  await db.exec('RESET ROLE;SET ROLE personal_photos_app')
  await expect(prunePhotoInferenceReceipts()).rejects.toThrow('permission denied')
  await db.exec('RESET ROLE')
  expect(state.finish).not.toHaveBeenCalled()
})

it('supports a conservative configured retention window and disabling cleanup', async () => {
  const { prunePhotoInferenceReceipts } = await import('@/lib/photos/photo-inference-retention')
  await state.db!
    .exec(`INSERT INTO photo_inference_receipts(photo_id,retired,prompt_version,source_path,state,ledger_done,updated_at)
    VALUES(1,true,'old','display/1','received',true,now()-interval '100 days')`)
  vi.stubEnv('PHOTO_AI_RECEIPT_RETENTION_DAYS', '0')
  expect(await prunePhotoInferenceReceipts()).toBe(0)
  vi.stubEnv('PHOTO_AI_RECEIPT_RETENTION_DAYS', '365')
  expect(await prunePhotoInferenceReceipts()).toBe(0)
  vi.stubEnv('PHOTO_AI_RECEIPT_RETENTION_DAYS', '30')
  expect(await prunePhotoInferenceReceipts()).toBe(1)
})

it.each(['-1', '1', '29', '3651', 'NaN', '30.5'])(
  'rejects unsafe receipt retention %s',
  async (value) => {
    const { prunePhotoInferenceReceipts } = await import('@/lib/photos/photo-inference-retention')
    vi.stubEnv('PHOTO_AI_RECEIPT_RETENTION_DAYS', value)
    await expect(prunePhotoInferenceReceipts()).rejects.toThrow(
      'Invalid PHOTO_AI_RECEIPT_RETENTION_DAYS',
    )
  },
)
