import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

const s = vi.hoisted(() => ({ db: null as any, tx: null as any, logs: vi.fn(), snow: vi.fn() }))
vi.mock('@/lib/postgres', () => ({
  pgQuery: async (sql: string, p?: unknown[]) => (await (s.tx ?? s.db).query(sql, p)).rows,
  pgTransaction: async (fn: () => Promise<unknown>) =>
    s.db.transaction(async (tx: any) => {
      s.tx = tx
      try {
        return await fn()
      } finally {
        s.tx = null
      }
    }),
  withAdvisoryLock: async (_: string, fn: () => Promise<unknown>) => fn(),
}))
vi.mock('@/lib/identity/auth0-management', () => ({ readAuth0LogPage: s.logs }))
vi.mock('@/lib/snowflake', () => ({ querySnowflake: s.snow }))
import { syncIdentity } from '@/lib/identity/identity-logs'

beforeAll(async () => {
  s.db = new PGlite()
  for (const f of ['16-user-activity', '17-detailed-usage', '18-identity-retention'])
    await s.db.exec(readFileSync(`setup/${f}.sql`, 'utf8'))
  await s.db.exec(
    "CREATE TABLE gallery_access_objects(kind text,name text,auth0_user_id text);INSERT INTO gallery_access_objects VALUES('user','GH','auth0|gh')",
  )
  vi.stubEnv('AUTH0_GALLERY_CLIENT_ID', 'galleryclient')
})
afterAll(async () => {
  await s.db.close()
  vi.unstubAllEnvs()
})
it('keeps committed checkpoints through failures and resumes without duplicate totals or Snowflake queries', async () => {
  const log = {
    client_id: 'galleryclient',
    user_id: 'auth0|gh',
    type: 's',
    log_id: '123',
    date: new Date().toISOString(),
  }
  s.logs
    .mockResolvedValueOnce({ logs: [log], cursor: '123' })
    .mockRejectedValueOnce(Error('private upstream error'))
  await expect(syncIdentity('auth0')).rejects.toThrow('Import failed')
  expect(
    (await s.db.query("SELECT cursor FROM identity_log_sync WHERE provider='auth0'")).rows[0]
      .cursor,
  ).toBe('123')
  await s.db.exec("UPDATE identity_log_sync SET attempted_at=now()-interval '1 minute'")
  s.logs
    .mockResolvedValueOnce({ logs: [log], cursor: '124' })
    .mockResolvedValueOnce({ logs: [], cursor: '124' })
  expect(await syncIdentity('auth0')).toMatchObject({ imported: 0, more: false })
  expect(s.logs.mock.calls[2][0]).toBe('123')
  expect((await s.db.query('SELECT events::int FROM user_activity_daily')).rows).toEqual([
    { events: 1 },
  ])
  expect(s.snow).not.toHaveBeenCalled()
  await expect(syncIdentity('auth0')).rejects.toMatchObject({ status: 429 })
})
it('imports the gateway client as well as the original client, excluding other applications', async () => {
  vi.stubEnv('AUTH0_GATEWAY_CLIENT_ID', 'gatewayclient')
  await s.db.exec("UPDATE identity_log_sync SET attempted_at=now()-interval '1 minute'")
  const common = { user_id: 'auth0|gh', type: 's', date: new Date().toISOString() }
  s.logs
    .mockResolvedValueOnce({
      logs: [
        { ...common, client_id: 'gatewayclient', log_id: '125' },
        { ...common, client_id: 'unrelatedclient', log_id: '126' },
      ],
      cursor: '126',
    })
    .mockResolvedValueOnce({ logs: [], cursor: '126' })
  expect(await syncIdentity('auth0')).toMatchObject({ imported: 1, more: false })
  expect((await s.db.query('SELECT events::int FROM user_activity_daily')).rows).toEqual([
    { events: 2 },
  ])
  expect(s.snow).not.toHaveBeenCalled()
})
