import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let db: PGlite
let connection: any
vi.mock('@/lib/postgres', () => ({
  pgQuery: async (sql: string, args?: unknown[]) =>
    (await (connection ?? db).query(sql, args)).rows,
  pgQueryOne: async (sql: string, args?: unknown[]) =>
    (await (connection ?? db).query(sql, args)).rows[0] ?? null,
  pgTransaction: async (fn: () => Promise<unknown>) =>
    db.transaction(async (tx) => {
      connection = tx
      try {
        return await fn()
      } finally {
        connection = undefined
      }
    }),
}))
vi.mock('@/lib/observability/user-activity', () => ({
  recordAction: async () => {
    await connection.query('INSERT INTO usage VALUES(1)')
  },
}))
import {
  claimUploadCompletion,
  publishUploadCompletion,
} from '@/lib/upload/upload-completion-claim'

const id = '00000000-0000-4000-8000-000000000001'
const token = '00000000-0000-4000-8000-000000000002'
const jobToken = '00000000-0000-4000-8000-000000000003'
beforeEach(async () => {
  db = new PGlite()
  await db.exec(`CREATE SCHEMA photo_security;
 CREATE FUNCTION photo_security.authorization_epoch() RETURNS text LANGUAGE sql AS $$SELECT '1'::text$$;
 CREATE TABLE upload_processing_jobs(upload_id uuid,owner text,state text,lease_token uuid,lease_until timestamptz,auth_epoch text,error text,updated_at timestamptz);
 CREATE TABLE upload_sessions(upload_id uuid,owner text,completion_token uuid,completion_lease_until timestamptz,result jsonb,bytes bigint);
 CREATE TABLE upload_chunks(upload_id uuid,stage_path text);
 CREATE TABLE stage_cleanup(path text,next_attempt timestamptz);
 CREATE TABLE catalog(id int);CREATE TABLE usage(id int);
 INSERT INTO upload_processing_jobs VALUES('${id}','ALICE','processing','${jobToken}',now()+interval '5 minutes','1',null,now());
 INSERT INTO upload_sessions VALUES('${id}','ALICE','${token}',now()+interval '5 minutes',null,123);
 INSERT INTO upload_chunks VALUES('${id}','chunk');INSERT INTO stage_cleanup VALUES('chunk',now()+interval '1 day');`)
})
afterEach(async () => {
  await db.close()
  vi.unstubAllEnvs()
})
it('rechecks account authority before queue locks or catalog publication', async () => {
  vi.stubEnv('CUSTOMER_ACCOUNTS_ENABLED', 'true')
  await db.exec(
    `CREATE FUNCTION photo_security.upload_account_allowed(owner text) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;`,
  )
  const publish = vi.fn()
  await expect(
    publishUploadCompletion(id, 'ALICE', token, publish, jobToken),
  ).rejects.toMatchObject({ status: 403 })
  await expect(claimUploadCompletion(id, 'ALICE', jobToken)).rejects.toMatchObject({ status: 403 })
  expect(publish).not.toHaveBeenCalled()
  expect((await db.query('SELECT state FROM upload_processing_jobs')).rows).toEqual([
    { state: 'processing' },
  ])
  expect((await db.query('SELECT * FROM upload_chunks')).rows).toHaveLength(1)
})
it('atomically publishes catalog, replay result, usage and job completion', async () => {
  const result = await publishUploadCompletion(
    id,
    'ALICE',
    token,
    async () => {
      await connection.query('INSERT INTO catalog VALUES(1)')
      return { successCount: 1 }
    },
    jobToken,
  )
  expect(result).toEqual({ successCount: 1 })
  expect((await db.query('SELECT state FROM upload_processing_jobs')).rows).toEqual([
    { state: 'done' },
  ])
  expect((await db.query('SELECT * FROM upload_chunks')).rows).toHaveLength(0)
  expect((await db.query('SELECT * FROM usage')).rows).toHaveLength(1)
  expect((await db.query('SELECT result FROM upload_sessions')).rows).toEqual([
    { result: { successCount: 1 } },
  ])
})
it('rolls everything back when publication fails', async () => {
  await expect(
    publishUploadCompletion(
      id,
      'ALICE',
      token,
      async () => {
        await connection.query('INSERT INTO catalog VALUES(1)')
        throw Error('crash')
      },
      jobToken,
    ),
  ).rejects.toThrow('crash')
  expect((await db.query('SELECT * FROM catalog')).rows).toHaveLength(0)
  expect((await db.query('SELECT state FROM upload_processing_jobs')).rows).toEqual([
    { state: 'processing' },
  ])
  expect((await db.query('SELECT * FROM upload_chunks')).rows).toHaveLength(1)
})
it('rejects expired leases, replacement claims and revoked authorization before touching the catalog', async () => {
  const publish = vi.fn()
  await db.exec("UPDATE upload_processing_jobs SET lease_until=now()-interval '1 second'")
  await expect(
    publishUploadCompletion(id, 'ALICE', token, publish, jobToken),
  ).rejects.toMatchObject({ status: 409 })
  await db.exec(
    "UPDATE upload_processing_jobs SET lease_until=now()+interval '5 minutes',auth_epoch='2'",
  )
  await expect(
    publishUploadCompletion(id, 'ALICE', token, publish, jobToken),
  ).rejects.toMatchObject({ status: 409 })
  await db.exec("UPDATE upload_processing_jobs SET auth_epoch='1'")
  await expect(publishUploadCompletion(id, 'ALICE', token, publish, token)).rejects.toMatchObject({
    status: 409,
  })
  expect(publish).not.toHaveBeenCalled()
})
it('confirms a re-authorized job before its queue fence, and publishes nothing if that fails', async () => {
  const publish = vi.fn()
  const order: string[] = []
  // The confirmation moves the job to the epoch its attempt read; the fence then applies.
  await db.exec("UPDATE upload_processing_jobs SET auth_epoch='0'")
  await expect(
    publishUploadCompletion(id, 'ALICE', token, publish, jobToken, async () => {
      throw Object.assign(new Error('denied'), { status: 403 })
    }),
  ).rejects.toMatchObject({ status: 403 })
  await expect(
    publishUploadCompletion(id, 'ALICE', token, publish, jobToken, async () => {
      order.push('confirm')
    }),
  ).rejects.toMatchObject({ status: 409 })
  expect(publish).not.toHaveBeenCalled()
  await publishUploadCompletion(
    id,
    'ALICE',
    token,
    async () => {
      order.push('publish')
      return {}
    },
    jobToken,
    async () => {
      order.push('confirm')
      await connection.query("UPDATE upload_processing_jobs SET auth_epoch='1'")
    },
  )
  expect(order).toEqual(['confirm', 'confirm', 'publish'])
  // A request's own completion has no queue job to confirm.
  const unused = vi.fn()
  await db.exec(
    `UPDATE upload_sessions SET result=NULL,completion_token='${token}',completion_lease_until=now()+interval '5 minutes'`,
  )
  await publishUploadCompletion(id, 'ALICE', token, async () => ({}), undefined, unused)
  expect(unused).not.toHaveBeenCalled()
})
