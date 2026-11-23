// Administrative routes, proven by outcome: each case sends a request to the real route
// handler and then reads the database. The real authorization code, database layer and
// row-level security all run; only the process edges are replaced (see
// fixtures/route-database), plus the search index sync, which talks to Snowflake.
import {
  APP_ORIGIN,
  type Caller,
  callerHeaders,
  createRouteDatabase,
  DATABASE_ENV,
  snowflakeRoleRows,
} from './fixtures/route-database'
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  headers: new Headers(),
  caller: null as Caller | null,
  syncSearch: vi.fn(),
}))
vi.mock('pg', async () =>
  (await import('./fixtures/route-database')).pgliteDriver(
    await vi.importActual<typeof import('pg')>('pg'),
    () => s.db,
  ),
)
vi.mock('next/headers', () => ({ headers: async () => s.headers }))
vi.mock('@/lib/snowflake', () => ({
  getServiceToken: () => 'platform-session',
  querySnowflake: async () => snowflakeRoleRows(s.caller),
}))
// The search index lives in Snowflake; only whether a sync was started is observable here.
vi.mock('@/lib/search/search-sync', () => ({ syncSearch: s.syncSearch }))
import { GET as activity, POST as activityAction } from '@/app/api/activity/route'
import { POST as startSearchSync } from '@/app/api/search-sync/route'
import { GET as sharedLinks } from '@/app/api/shared-links/route'
import { closePool } from '@/lib/postgres'

// ALICE is an ordinary member. AUDITOR is a read-only administrator. ADMIN is an
// administrator without main-administrator standing. OWNER is the main administrator.
const ALICE: Caller = { username: 'ALICE', roles: ['viewer'] }
const AUDITOR: Caller = { username: 'AUDITOR', roles: ['admin_readonly'] }
const ADMIN: Caller = { username: 'ADMIN', roles: ['admin'] }
const OWNER: Caller = { username: 'OWNER', roles: ['admin'] }
function signIn(caller: Caller | null) {
  s.caller = caller
  s.headers = callerHeaders(caller)
}
const post = (body: object, method = 'POST') =>
  new Request(APP_ORIGIN + '/api/test', {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
const rows = async (sql: string) => (await s.db.query(sql)).rows as Record<string, unknown>[]

beforeAll(async () => {
  for (const [name, value] of Object.entries(DATABASE_ENV)) vi.stubEnv(name, value)
  s.db = await createRouteDatabase()
}, 60_000)
afterAll(async () => {
  await closePool()
  await s.db?.close()
  vi.unstubAllEnvs()
})
beforeEach(async () => {
  signIn(null)
  s.syncSearch.mockReset()
  // Alice's private album has one photo whose description failed for good and one public
  // link; the album shared with every signed-in user has one photo. Two stored files could
  // not be deleted. Rows are deleted, not truncated: statistics are kept by row triggers.
  await s.db
    .exec(`DELETE FROM album_public_links;DELETE FROM photos;DELETE FROM events;DELETE FROM search_queue;DELETE FROM stage_cleanup;DELETE FROM gallery_main_admins;
 INSERT INTO gallery_main_admins(username) VALUES('OWNER');
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES
  (1,1,'Alice private','alice','ALICE','PRIVATE'),(2,2,'Everyone','everyone','OWNER','GALLERY');
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,display_stage_path,ai_attempts,ai_error) VALUES
  (1,1,'failed.jpg','photo','READY','display/1',3,'model refused'),(2,2,'shared.jpg','photo','READY','display/2',0,NULL);
 INSERT INTO album_public_links(id,event_id,token_hash,owner_username,created_by,expires_at) VALUES
  ('11111111-1111-4111-8111-111111111111',1,repeat('a',64),'ALICE','ALICE',now()+interval '1 hour');
 INSERT INTO stage_cleanup(path,next_attempt,attempts,last_error) VALUES
  ('originals/stuck-1.jpg',now()+interval '1 day',5,'storage unavailable'),
  ('originals/stuck-2.jpg',now()+interval '1 day',5,'storage unavailable');`)
})

const cleanup = () =>
  rows(
    'SELECT path,attempts,last_error,next_attempt<=now() AS due FROM stage_cleanup ORDER BY path',
  )
const STUCK = [
  { path: 'originals/stuck-1.jpg', attempts: 5, last_error: 'storage unavailable', due: false },
  { path: 'originals/stuck-2.jpg', attempts: 5, last_error: 'storage unavailable', due: false },
]

it('refuses the activity report to a member and to a caller without a session', async () => {
  signIn(null)
  expect((await activity()).status).toBe(401)
  signIn(ALICE)
  const response = await activity()
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({
    error: 'Administrative visibility required',
    code: 'ACCESS_DENIED',
  })
})

it.each([
  ['a read-only administrator', AUDITOR],
  ['an administrator who is not the main administrator', ADMIN],
])('shows %s activity only for albums that caller may read', async (_name, caller) => {
  signIn(caller)
  const response = await activity()
  expect(response.status).toBe(200)
  const body = await response.json()
  // Alice's failed photo and the storage backlog are not this caller's to see.
  expect(body.failures).toEqual([])
  expect(body.cleanup).toEqual([])
  expect(body.summary).toMatchObject({ cleanup_intents: '0', pending_sync: 2, pending_ai: 1 })
})

it('shows the main administrator activity for the whole library', async () => {
  signIn(OWNER)
  const body = await (await activity()).json()
  expect(body.failures).toMatchObject([
    { photo_id: 1, source_filename: 'failed.jpg', ai_error: 'model refused', ai_attempts: 3 },
  ])
  expect(body.cleanup.map((item: { path: string }) => item.path)).toEqual([
    'originals/stuck-1.jpg',
    'originals/stuck-2.jpg',
  ])
  expect(body.summary).toMatchObject({ cleanup_intents: '2', pending_sync: 4, pending_ai: 1 })
})

it('lets only the main administrator retry failed storage cleanup', async () => {
  const retry = () => activityAction(post({ action: 'retry-cleanup' }))
  for (const [caller, status] of [
    [null, 401],
    [ALICE, 403],
    [AUDITOR, 403],
    [ADMIN, 403],
  ] as const) {
    signIn(caller)
    expect((await retry()).status).toBe(status)
    expect(await cleanup()).toEqual(STUCK)
  }
  signIn(OWNER)
  // Not from another site, and not for an action the route does not know.
  s.headers.set('origin', 'https://elsewhere.example')
  expect((await retry()).status).toBe(403)
  signIn(OWNER)
  expect((await activityAction(post({ action: 'delete-everything' }))).status).toBe(400)
  expect(await cleanup()).toEqual(STUCK)
  expect((await retry()).status).toBe(200)
  expect(await cleanup()).toEqual([
    { path: 'originals/stuck-1.jpg', attempts: 0, last_error: null, due: true },
    { path: 'originals/stuck-2.jpg', attempts: 0, last_error: null, due: true },
  ])
})

it('lists public links to administrators, and a member’s private links only to the main administrator', async () => {
  const list = (query = '') => sharedLinks(new Request(APP_ORIGIN + '/api/shared-links' + query))
  signIn(null)
  expect((await list()).status).toBe(401)
  signIn(ALICE)
  expect((await list()).status).toBe(403)
  for (const caller of [AUDITOR, ADMIN]) {
    signIn(caller)
    const response = await list()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ links: [], owners: [], canFilterOwners: false })
  }
  signIn(OWNER)
  expect(await (await list()).json()).toMatchObject({
    links: [{ event_id: 1, owner_username: 'ALICE', status: 'active' }],
    owners: ['ALICE'],
    canFilterOwners: true,
  })
  expect(await (await list('?status=revoked')).json()).toMatchObject({ links: [] })
  expect((await list('?status=everything')).status).toBe(400)
})

it('lets only the main administrator start a search index sync', async () => {
  const start = () => startSearchSync(post({ full: true }))
  for (const [caller, status] of [
    [null, 401],
    [ALICE, 403],
    [AUDITOR, 403],
    [ADMIN, 403],
  ] as const) {
    signIn(caller)
    expect((await start()).status).toBe(status)
  }
  signIn(OWNER)
  s.headers.set('origin', 'https://elsewhere.example')
  expect((await start()).status).toBe(403)
  expect(s.syncSearch).not.toHaveBeenCalled()
  signIn(OWNER)
  s.syncSearch.mockResolvedValue({ photos: { synced: 2 }, events: { synced: 2 } })
  const response = await start()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ photos: { synced: 2 }, events: { synced: 2 } })
  expect(s.syncSearch).toHaveBeenCalledExactlyOnceWith({ force: true, full: true })
})
