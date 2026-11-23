import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

const state = vi.hoisted(() => ({ db: null as any, tx: null as any }))
vi.mock('@/lib/postgres', () => ({
  pgQuery: async (sql: string, params?: unknown[]) =>
    (await (state.tx ?? state.db).query(sql, params)).rows,
  pgTransaction: async (fn: () => Promise<unknown>) =>
    state.db.transaction(async (tx: any) => {
      state.tx = tx
      try {
        return await fn()
      } finally {
        state.tx = null
      }
    }),
}))
import {
  activityReport,
  cleanupActivity,
  parseViews,
  recordAction,
  recordViews,
} from '@/lib/observability/user-activity'

const id = '11111111-1111-4111-8111-111111111111'
const event = '22222222-2222-4222-8222-222222222222'
beforeAll(async () => {
  state.db = new PGlite()
  await state.db
    .exec(`CREATE TABLE gallery_access_objects(kind text,name text,display_name text,email text);
    CREATE TABLE deleted_accounts(name text,display_name text,email text);`)
  await state.db.exec(readFileSync('setup/16-user-activity.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/17-detailed-usage.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/18-identity-retention.sql', 'utf8'))
})
afterAll(async () => {
  await state.db.close()
})
beforeEach(async () => {
  await state.db.exec(
    'TRUNCATE user_activity_daily,identity_log_sync,user_activity_sessions,user_activity_events,user_activity_maintenance',
  )
})
it('rejects arbitrary data, query strings, forged action kinds and oversized batches', () => {
  for (const v of [
    [{ id: event, path: '/search?password=secret' }],
    [{ id: 'bad', path: '/' }],
    [{ id: event, path: '/api/admin/access' }],
    Array(21).fill({ id: event, path: '/' }),
  ])
    expect(() => parseViews(v)).toThrow()
  expect(() =>
    parseViews([{ id: event, path: '/photos/2', username: 'other', kind: 'user_deleted' }]),
  ).toThrow()
  expect(parseViews([{ id: event, path: '/photos/2', username: 'other' }])).toEqual([
    { id: event, path: '/photos/2' },
  ])
})
it('deduplicates retries and keeps heartbeat in the same session', async () => {
  const s = await recordViews('alice', id, [{ id: event, path: '/photos/2' }])
  expect(s).not.toBe(id)
  expect(await recordViews('alice', s, [{ id: event, path: '/photos/2' }])).toBe(s)
  expect(await recordViews('alice', s, [])).toBe(s)
  const report = await activityReport('', '')
  expect(report.totals).toMatchObject({ users: 1, visits: 1, photos: 1, active: 1 })
  expect(report.events).toHaveLength(2)
})
it('rotates expired sessions and cannot reuse another user session', async () => {
  const s = await recordViews('alice', id, [])
  expect(await recordViews('bob', s, [])).not.toBe(s)
  await state.db.query(
    "UPDATE user_activity_sessions SET last_seen=now()-interval '31 minutes' WHERE session_id=$1",
    [s],
  )
  expect(await recordViews('alice', s, [])).not.toBe(s)
})
it('filters reports and records server actions without creating false visits', async () => {
  await recordAction('alice', 'photo_trashed', 'photo:4')
  await recordAction('bob', 'album_changed', 'album:1')
  const report = await activityReport('alice', 'photo_trashed')
  expect(report.events).toHaveLength(1)
  expect(report.totals.visits).toBe(0)
  expect(report.events[0]).toMatchObject({ source: 'server', username: 'alice' })
})
it('removes old detail in explicit maintenance', async () => {
  await state.db.exec(
    "INSERT INTO user_activity_events(event_id,username,session_id,occurred_at,kind,target,source) VALUES('11111111-1111-4111-8111-111111111111','old',null,now()-interval '91 days','page_view','/','browser')",
  )
  await cleanupActivity()
  await recordViews('alice', id, [])
  expect(
    (await state.db.query("SELECT * FROM user_activity_events WHERE username='old'")).rows,
  ).toHaveLength(0)
})
it('deduplicates watch-time batches and rejects implausible telemetry', async () => {
  for (const seconds of [-1, 0, 61, NaN, Infinity])
    expect(() =>
      parseViews([{ id: event, path: '/photos/2', kind: 'video_watch', seconds }]),
    ).toThrow()
  const views = parseViews([{ id: event, path: '/photos/2', kind: 'video_watch', seconds: 15.5 }])
  const s = await recordViews('alice', id, views)
  await recordViews('alice', s, views)
  expect((await activityReport('alice', '')).totals.watch_seconds).toBe(15.5)
})
it('deduplicates upload completion but keeps identities and outcomes separate', async () => {
  await recordAction(
    'alice',
    'upload_completed',
    'upload:a',
    { bytes: 1024, files: 1, outcome: 'success' },
    'a',
  )
  await recordAction(
    'alice',
    'upload_completed',
    'upload:a',
    { bytes: 1024, files: 1, outcome: 'success' },
    'a',
  )
  await recordAction(
    'alice',
    'upload_completed',
    'upload:b',
    { bytes: 1024, files: 1, outcome: 'skipped' },
    'b',
  )
  await recordAction(
    'bob',
    'upload_completed',
    'upload:a',
    { bytes: 2048, files: 1, outcome: 'success' },
    'a',
  )
  const r = await activityReport('alice', '')
  expect(r.totals).toMatchObject({ uploads_saved: 1, uploads_skipped: 1, upload_bytes: 1024 })
})
it('summarizes search modes, empty results, failures and requested download volume', async () => {
  await recordAction('alice', 'search_performed', '', {
    query: 'car',
    mode: 'semantic',
    outcome: 'success',
    results: 0,
    durationMs: 100,
  })
  await recordAction('alice', 'search_performed', '', {
    query: 'boat',
    mode: 'auto',
    outcome: 'failed',
    durationMs: 200,
    status: 503,
  })
  await recordAction('alice', 'download_requested', 'zip', { files: 3, bytes: 3000 })
  expect((await activityReport('alice', '')).totals).toMatchObject({
    searches: 2,
    semantic_searches: 1,
    empty_searches: 1,
    search_failures: 1,
    search_ms: 150,
    downloads: 1,
    download_files: 3,
    download_bytes: 3000,
  })
})
it('paginates tied microsecond timestamps without gaps or duplicates', async () => {
  for (let i = 0; i < 105; i++) await recordAction('alice', 'photo_view', String(i))
  await state.db.exec(
    "UPDATE user_activity_events SET occurred_at=date_trunc('day',now())+interval '12.123456 seconds'",
  )
  const a = await activityReport('alice', '')
  expect(a.events).toHaveLength(100)
  expect(a.next).toBeTruthy()
  const b = await activityReport('alice', '', 30, a.next!)
  expect(b.events).toHaveLength(5)
  expect(b.next).toBeNull()
  expect(new Set([...a.events, ...b.events].map((e) => e.event_id)).size).toBe(105)
})
it('retains daily totals after detail purge and migration reruns without double counting', async () => {
  await recordAction(
    'alice',
    'upload_completed',
    'upload:a',
    { bytes: 1024, files: 1, outcome: 'success' },
    'stable',
  )
  await recordAction(
    'alice',
    'upload_completed',
    'upload:a',
    { bytes: 1024, files: 1, outcome: 'success' },
    'stable',
  )
  await state.db.exec(readFileSync('setup/18-identity-retention.sql', 'utf8'))
  let rows = (
    await state.db.query('SELECT events::int,bytes::int,successes::int FROM user_activity_daily')
  ).rows
  expect(rows).toEqual([{ events: 1, bytes: 1024, successes: 1 }])
  await state.db.exec('DELETE FROM user_activity_events')
  await state.db.exec(readFileSync('setup/18-identity-retention.sql', 'utf8'))
  rows = (
    await state.db.query('SELECT events::int,bytes::int,successes::int FROM user_activity_daily')
  ).rows
  expect(rows).toEqual([{ events: 1, bytes: 1024, successes: 1 }])
})

it('accepts the travels page without accepting query strings or arbitrary subpaths', () => {
  expect(parseViews([{ id: event, path: '/travels' }])).toEqual([{ id: event, path: '/travels' }])
  expect(() => parseViews([{ id: event, path: '/travels?private=value' }])).toThrow()
  expect(() => parseViews([{ id: event, path: '/travels/secret' }])).toThrow()
})

it('resolves current and archived display identities without exposing opaque IDs as labels', async () => {
  await state.db
    .exec(`INSERT INTO gallery_access_objects VALUES('user','U_abcdef','Alice','alice@example.com');
    INSERT INTO deleted_accounts VALUES('U_123abc','Former Alice','former@example.com');`)
  await recordAction('U_abcdef', 'photo_view', '1')
  await recordAction('U_123abc', 'photo_view', '2')
  await recordAction('U_deadbeef', 'photo_view', '3')
  const report = await activityReport('', '')
  expect(report.users.find((u) => u.username === 'U_abcdef')).toMatchObject({
    displayName: 'Alice',
    email: 'alice@example.com',
  })
  expect(report.events.find((u) => u.username === 'U_123abc')).toMatchObject({
    displayName: 'Former Alice',
    email: 'former@example.com',
  })
  expect(report.users.find((u) => u.username === 'U_deadbeef')).toMatchObject({
    displayName: 'Former member',
    email: null,
  })
})
