// GET /api/stats against a real database: the real route, authorization, database layer
// and row-level security. Only the process edges are replaced (see fixtures/route-database).
import {
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
import { GET as statistics } from '@/app/api/stats/route'
import { closePool } from '@/lib/postgres'

const OWNER: Caller = { username: 'OWNER', roles: ['admin'] }
const ALICE: Caller = { username: 'ALICE', roles: ['viewer'] }
const ADMIN: Caller = { username: 'ADMIN', roles: ['admin'] }
const AUDITOR: Caller = { username: 'AUDITOR', roles: ['admin_readonly'] }
function signIn(caller: Caller | null) {
  s.caller = caller
  s.headers = callerHeaders(caller)
}

beforeAll(async () => {
  for (const [name, value] of Object.entries(DATABASE_ENV)) vi.stubEnv(name, value)
  s.db = await createRouteDatabase()
  // A small library: two private albums and one album shared with every signed-in user.
  await s.db.exec(`INSERT INTO gallery_main_admins(username) VALUES('OWNER');
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES
  (1,1,'Alice private','alice','ALICE','PRIVATE'),(2,2,'Bob private','bob','BOB','PRIVATE'),(3,3,'Everyone','all','OWNER','GALLERY');
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,display_stage_path,ai_description,ai_attempts) VALUES
  (1,1,'described.jpg','photo','READY','display/1','A described photo',1),
  (2,1,'waiting.jpg','photo','READY','display/2',NULL,0),
  (3,1,'clip.mp4','video','READY','display/3',NULL,0),
  (4,2,'exhausted.jpg','photo','READY','display/4',NULL,3),
  (5,3,'shared.jpg','photo','READY','display/5','A shared photo',1);
 UPDATE photos SET search_synced_at=now() WHERE photo_id=5;`)
}, 60_000)
afterAll(async () => {
  await closePool()
  await s.db?.close()
  vi.unstubAllEnvs()
})
beforeEach(() => signIn(null))

it('gives the main administrator the counters for the whole library', async () => {
  signIn(OWNER)
  const response = await statistics()
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toContain('no-store')
  const { observed_at, ...body } = await response.json()
  // Four photos (one described and searchable, one described, one waiting, one that used
  // every description attempt) and one video; all five items and three albums await sync.
  expect(body).toEqual({
    total_photos: 4,
    total_videos: 1,
    photos_with_ai: 2,
    photos_without_ai: 1,
    photos_failed: 1,
    in_search: 1,
    pending_photo_updates: 5,
    pending_album_updates: 3,
    pending_photo_removals: 0,
    pending_album_removals: 0,
    pending_sync: 8,
    pending_search_removals: 0,
    failed_photos: [{ photo_id: 4, source_filename: 'exhausted.jpg', ai_error: null }],
    failures_limit: 50,
  })
  expect(Math.abs(Date.parse(observed_at) - Date.now())).toBeLessThan(60_000)
})

it('counts a change to the library on the next read', async () => {
  signIn(OWNER)
  await s.db.exec(
    "INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,display_stage_path) VALUES(6,2,'new.jpg','photo','READY','display/6')",
  )
  try {
    const body = await (await statistics()).json()
    expect(body).toMatchObject({ total_photos: 5, photos_without_ai: 2, pending_photo_updates: 6 })
  } finally {
    await s.db.exec('DELETE FROM photos WHERE photo_id=6')
  }
  expect(await (await statistics()).json()).toMatchObject({ total_photos: 4, photos_without_ai: 1 })
})

it.each([
  ['a read-only administrator', AUDITOR],
  ['an administrator who is not the main administrator', ADMIN],
])('gives %s only the albums that caller may read', async (_name, caller) => {
  signIn(caller)
  const response = await statistics()
  expect(response.status).toBe(200)
  // Row-level security leaves only the album shared with every signed-in user.
  expect(await response.json()).toMatchObject({
    total_photos: 1,
    total_videos: 0,
    photos_with_ai: 1,
    photos_without_ai: 0,
    photos_failed: 0,
    in_search: 1,
    pending_sync: 2,
    failed_photos: [],
  })
})

it('refuses a member and a caller without a session, and returns no counters', async () => {
  signIn(ALICE)
  const member = await statistics()
  expect(member.status).toBe(403)
  expect(await member.json()).toEqual({
    error: 'Administrative visibility required',
    code: 'ACCESS_DENIED',
  })
  signIn(null)
  const anonymous = await statistics()
  expect(anonymous.status).toBe(401)
  expect(await anonymous.json()).toEqual({
    error: 'Authentication required',
    code: 'SESSION_REQUIRED',
  })
})
