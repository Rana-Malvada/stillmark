import { beforeEach, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { EmailAlerts } from '../cloudflare-gateway/alerts.mjs'
import { createHmac } from 'node:crypto'

const query = vi.hoisted(() => vi.fn())
const list = vi.hoisted(() => vi.fn())
vi.mock('@/lib/postgres', () => ({ pgQueryOne: query, pgQuery: list }))
vi.mock('@/lib/snowflake', () => ({
  getSecret: () => 'ab'.repeat(32),
  SecretType: { GENERIC_STRING: 'GENERIC_STRING' },
}))
import { GET } from '@/app/api/health/monitor/route'

function request(time = Date.now(), user = 'PERSONAL_PHOTOS_GATEWAY') {
  const stamp = String(time)
  const signature = createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex'))
    .update('photo-monitor-v1:' + stamp)
    .digest('hex')
  return new Request('https://origin/api/health/monitor', {
    headers: {
      'sf-context-current-user': user,
      'x-photo-monitor-time': stamp,
      'x-photo-monitor-signature': signature,
    },
  })
}
beforeEach(() => {
  query.mockReset()
  list.mockReset()
  vi.unstubAllEnvs()
})
it('denies unsigned, stale, forged, and non-gateway requests without database access', async () => {
  const forged = request()
  forged.headers.set('x-photo-monitor-signature', '00'.repeat(32))
  for (const req of [
    new Request('https://origin/api/health/monitor'),
    request(Date.now() - 60000),
    request(Date.now(), 'ADMIN'),
    forged,
  ])
    expect((await GET(req)).status).toBe(401)
  expect(query).not.toHaveBeenCalled()
})
it('returns only aggregated monitoring data', async () => {
  query.mockResolvedValue({ bytes: '123', failed: 4 })
  const r = await GET(request())
  expect(await r.json()).toEqual({ database: true, databaseBytes: 123, failedUploadsLastHour: 4 })
  expect(r.headers.get('cache-control')).toBe('no-store')
})
it('lists recent self-registrations without email, login or username, and only when accounts are enabled', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE ROLE personal_photos_maintenance; CREATE ROLE personal_photos_app; CREATE SCHEMA photo_security;
      GRANT USAGE ON SCHEMA photo_security TO personal_photos_maintenance,personal_photos_app;
      CREATE TABLE gallery_access_objects(kind text,name text,marker uuid PRIMARY KEY,display_name text,email text,
        auth0_user_id text,registration_source text,created_at timestamptz);
      INSERT INTO gallery_access_objects VALUES
       ('user','U_1','11111111-1111-4111-8111-111111111111','Ada','ada@example.invalid','auth0|1','public',now()-interval '2 hours'),
       ('user','U_2','22222222-2222-4222-8222-222222222222','Bo','bo@example.invalid','auth0|2','public',now()-interval '1 hour'),
       ('user','U_3','33333333-3333-4333-8333-333333333333','Old','old@example.invalid','auth0|3','public',now()-interval '49 hours'),
       ('user','MANAGED','44444444-4444-4444-8444-444444444444','Managed','m@example.invalid','auth0|4','managed',now()),
       ('role','ROLE','55555555-5555-4555-8555-555555555555','Role',NULL,NULL,'public',now());`)
    await db.exec(readFileSync('migrations/postgres/202611220300_signup_notifications.sql', 'utf8'))
    await db.exec('SET ROLE personal_photos_app')
    await expect(db.query('SELECT * FROM photo_security.recent_public_signups()')).rejects.toThrow(
      'permission denied',
    )
    await db.exec('RESET ROLE; SET ROLE personal_photos_maintenance')
    await expect(db.query('SELECT * FROM gallery_access_objects')).rejects.toThrow(
      'permission denied',
    )
    query.mockResolvedValue({ bytes: '123', failed: 0 })
    list.mockImplementation(async (sql: string) => (await db.query(sql)).rows)
    expect(await (await GET(request())).json()).toEqual({
      database: true,
      databaseBytes: 123,
      failedUploadsLastHour: 0,
    })
    expect(list).not.toHaveBeenCalled()
    vi.stubEnv('CUSTOMER_ACCOUNTS_ENABLED', 'true')
    const data = await (await GET(request())).json()
    expect(data.recentSignups).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        displayName: 'Ada',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        displayName: 'Bo',
      },
    ])
    expect(JSON.stringify(data)).not.toMatch(/example\.invalid|auth0|U_1/)
    // An unavailable signup list never reports the database as unhealthy.
    list.mockRejectedValue(Error('function does not exist'))
    expect(await (await GET(request())).json()).toEqual({
      database: true,
      databaseBytes: 123,
      failedUploadsLastHour: 0,
    })
  } finally {
    await db.close()
  }
})
it('reports database failure without leaking errors', async () => {
  query.mockRejectedValue(Error('secret host'))
  expect(await (await GET(request())).json()).toEqual({ database: false })
})
it('reports real terminal queue failures through the gateway monitor and recovers after retry', async () => {
  const db = new PGlite()
  const originalFetch = globalThis.fetch
  try {
    await db.exec(`CREATE SCHEMA photo_security;
      CREATE TABLE upload_processing_jobs(upload_id int PRIMARY KEY,state text,updated_at timestamptz DEFAULT now());
      CREATE TABLE upload_files(status text,completed_at timestamptz,started_at timestamptz);
      INSERT INTO upload_processing_jobs VALUES(1,'failed',now()),(2,'failed',now()),(3,'failed',now()),
        (4,'queued',now()),(5,'processing',now()),(6,'failed',now()-interval '2 hours');`)
    await db.exec(
      readFileSync('migrations/postgres/202611081520_upload_failure_timestamp.sql', 'utf8'),
    )
    query.mockImplementation(async (sql: string) => (await db.query(sql)).rows[0])
    const response = await GET(request())
    const data = await response.json()
    expect(data).toMatchObject({ database: true, failedUploadsLastHour: 3 })
    const state = new Map()
    const monitor = new EmailAlerts(
      {
        storage: {
          get: async (key: string) => state.get(key),
          put: async (key: string, value: unknown) => state.set(key, value),
        },
      },
      {
        GATEWAY_SIGNING_KEY: 'ab'.repeat(32),
        SNOWFLAKE_ORIGIN: 'https://example.snowflakecomputing.app',
        PG_STORAGE_WARNING_BYTES: '999999999999',
        GATEWAY_TOKENS: {
          idFromName: () => 1,
          get: () => ({
            fetch: async (url: string) =>
              url.endsWith('/token')
                ? new Response('test')
                : Response.json({ expiresAt: Date.now() + 10 * 86400000 }),
          }),
        },
      },
    )
    globalThis.fetch = vi.fn(async (input) => {
      if (new URL(String(input)).pathname.endsWith('/live')) return Response.json({ status: 'ok' })
      return GET(request())
    })
    expect(await monitor.check()).toMatchObject({ uploads: false, database: true })
    const before = (
      await db.query<{ failed_at: Date | null }>(
        'SELECT failed_at FROM upload_processing_jobs WHERE upload_id=1',
      )
    ).rows[0].failed_at
    await db.exec(
      "UPDATE upload_processing_jobs SET updated_at=now()+interval '1 hour' WHERE upload_id=1",
    )
    expect(
      (
        await db.query<{ failed_at: Date | null }>(
          'SELECT failed_at FROM upload_processing_jobs WHERE upload_id=1',
        )
      ).rows[0].failed_at,
    ).toEqual(before)
    await db.exec("UPDATE upload_processing_jobs SET state='queued' WHERE upload_id IN (1,2,3)")
    expect(
      (
        await db.query<{ failed_at: Date | null }>(
          'SELECT failed_at FROM upload_processing_jobs WHERE upload_id=1',
        )
      ).rows[0].failed_at,
    ).toBeNull()
    state.delete('lastCheck')
    expect(await monitor.check()).toMatchObject({ uploads: true })
    await db.exec("UPDATE upload_processing_jobs SET state='failed' WHERE upload_id IN (1,2,3)")
    expect(await (await GET(request())).json()).toMatchObject({ failedUploadsLastHour: 3 })
  } finally {
    globalThis.fetch = originalFetch
    await db.close()
  }
})
