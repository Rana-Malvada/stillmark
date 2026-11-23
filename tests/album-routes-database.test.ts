// Who may change an album, its photos and its Trash, proven by outcome: each case sends a
// request to the real route handler and then reads the database. The real authorization
// code, database layer and row-level security all run; only the process edges are replaced
// (see fixtures/route-database).
import {
  APP_ORIGIN,
  type Caller,
  callerHeaders,
  createRouteDatabase,
  DATABASE_ENV,
  snowflakeRoleRows,
} from './fixtures/route-database'
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
  querySnowflakeStorage: async () => {
    throw new Error('These routes must not reach stage storage')
  },
}))
import {
  HEAD as albumExists,
  DELETE as deleteAlbum,
  PATCH as editAlbum,
} from '@/app/api/events/[eventId]/route'
import { GET as reviewAlbum } from '@/app/api/events/[eventId]/review/route'
import { POST as changeSharing, GET as readSharing } from '@/app/api/events/[eventId]/sharing/route'
import { PATCH as chooseCover, DELETE as deletePhoto } from '@/app/api/photos/[photoId]/route'
import { PATCH as setDate } from '@/app/api/photos/[photoId]/date/route'
import { POST as bulk } from '@/app/api/photos/bulk/route'
import { GET as listTrash, DELETE as purgeTrash, POST as restoreTrash } from '@/app/api/trash/route'
import { withDatabaseRequest } from '@/lib/database/database-context'
import { closePool, pgQuery } from '@/lib/postgres'

// ALICE and BOB are ordinary members. AUDITOR is a read-only administrator. ADMIN is an
// administrator without main-administrator standing. OWNER is the main administrator.
const ALICE: Caller = { username: 'ALICE', roles: ['viewer'] }
const BOB: Caller = { username: 'BOB', roles: ['viewer'] }
const AUDITOR: Caller = { username: 'AUDITOR', roles: ['admin_readonly'] }
const ADMIN: Caller = { username: 'ADMIN', roles: ['admin'] }
const OWNER: Caller = { username: 'OWNER', roles: ['admin'] }
function signIn(caller: Caller | null) {
  s.caller = caller
  s.headers = callerHeaders(caller)
}

const album = (eventId: number) => ({ params: Promise.resolve({ eventId: String(eventId) }) })
const photo = (photoId: number) => ({ params: Promise.resolve({ photoId: String(photoId) }) })
const request = (method: string, body?: object, path = '/api/test') =>
  new Request(APP_ORIGIN + path, {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : {}),
  })
const rows = async (sql: string) => (await s.db.query(sql)).rows as Record<string, unknown>[]
/** Everything these routes can change, so "nothing changed" is one comparison. */
async function contents() {
  return JSON.stringify({
    albums: await rows('SELECT * FROM events ORDER BY event_id'),
    photos: await rows('SELECT * FROM photos ORDER BY photo_id'),
    trash: await rows('SELECT * FROM photo_trash ORDER BY photo_id'),
    shares: await rows('SELECT * FROM album_shares ORDER BY event_id,username'),
    cleanup: await rows('SELECT path FROM stage_cleanup ORDER BY path'),
  })
}

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
  // Albums 1 and 4 are Alice's and private, album 2 is Bob's and private, album 3 is shared
  // with every signed-in user. Photos 10 and 11 are in Trash, from Alice and from Bob.
  // Rows are deleted, not truncated: the statistics projection is maintained by row triggers.
  await s.db
    .exec(`DELETE FROM album_shares;DELETE FROM photo_trash;DELETE FROM photos;DELETE FROM events;
 DELETE FROM search_queue;DELETE FROM stage_cleanup;DELETE FROM gallery_main_admins;DELETE FROM gallery_access_objects;
 INSERT INTO gallery_main_admins(username) VALUES('OWNER');
 INSERT INTO gallery_access_objects(kind,name,marker,display_name,created_by,state) VALUES
  ('user','ALICE','11111111-1111-4111-8111-111111111111','Alice','OWNER','ready'),
  ('user','BOB','22222222-2222-4222-8222-222222222222','Bob','OWNER','ready');
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES
  (1,1,'Alice private','alice','ALICE','PRIVATE'),(2,2,'Bob private','bob','BOB','PRIVATE'),
  (3,3,'Everyone','everyone','OWNER','GALLERY'),(4,4,'Alice second','alice-2','ALICE','PRIVATE');
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path,display_stage_path,thumbnail_stage_path) VALUES
  (1,1,'a1.jpg','photo','READY','originals/a1.jpg','display/a1.jpg','thumbnails/a1.jpg'),
  (2,1,'a2.jpg','photo','READY','originals/a2.jpg','display/a2.jpg','thumbnails/a2.jpg'),
  (3,2,'b1.jpg','photo','READY','originals/b1.jpg','display/b1.jpg','thumbnails/b1.jpg'),
  (4,3,'e1.jpg','photo','READY','originals/e1.jpg','display/e1.jpg','thumbnails/e1.jpg'),
  (10,1,'a-trashed.jpg','photo','READY','originals/a-trashed.jpg','display/a-trashed.jpg','thumbnails/a-trashed.jpg'),
  (11,2,'b-trashed.jpg','photo','READY','originals/b-trashed.jpg','display/b-trashed.jpg','thumbnails/b-trashed.jpg');
 INSERT INTO photo_trash(photo_id,photo_data,album_name) SELECT p.photo_id,to_jsonb(p),e.event_name FROM photos p JOIN events e USING(event_id) WHERE p.photo_id IN (10,11);
 DELETE FROM photos WHERE photo_id IN (10,11);
 UPDATE events SET cover_photo_id=1 WHERE event_id=1;`)
})

/** One change to Alice's private album 1, and what the database shows once it has happened. */
type Change = { name: string; send: () => Promise<Response>; applied: () => Promise<boolean> }
const one = async (sql: string) => (await rows(sql))[0]
const changes: Change[] = [
  {
    name: 'rename the album',
    send: () => editAlbum(request('PATCH', { eventName: 'Renamed' }), album(1)),
    applied: async () =>
      (await one('SELECT event_name FROM events WHERE event_id=1'))?.event_name === 'Renamed',
  },
  {
    name: 'move the album to Trash',
    send: () => deleteAlbum(request('DELETE'), album(1)),
    applied: async () =>
      !(await one('SELECT 1 FROM events WHERE event_id=1')) &&
      (await rows('SELECT 1 FROM photo_trash WHERE photo_id IN (1,2)')).length === 2,
  },
  {
    name: 'share the album with every signed-in user',
    send: () =>
      changeSharing(request('POST', { action: 'visibility', visibility: 'GALLERY' }), album(1)),
    applied: async () =>
      (await one('SELECT visibility FROM events WHERE event_id=1'))?.visibility === 'GALLERY',
  },
  {
    name: 'share the album with another member',
    send: () => changeSharing(request('POST', { action: 'share', username: 'bob' }), album(1)),
    applied: async () =>
      (await rows("SELECT 1 FROM album_shares WHERE event_id=1 AND username='BOB'")).length === 1,
  },
  {
    name: 'mark a photo as a favorite',
    send: () => bulk(request('POST', { action: 'favorite', ids: [1] })),
    applied: async () =>
      (await one('SELECT favorite FROM photos WHERE photo_id=1'))?.favorite === true,
  },
  {
    name: 'move a photo to Trash in bulk',
    send: () => bulk(request('POST', { action: 'trash', ids: [1] })),
    applied: async () =>
      !(await one('SELECT 1 FROM photos WHERE photo_id=1')) &&
      !!(await one('SELECT 1 FROM photo_trash WHERE photo_id=1')),
  },
  {
    name: 'move a photo to the owner’s other album',
    send: () => bulk(request('POST', { action: 'move', ids: [1], eventId: 4 })),
    applied: async () =>
      (await one('SELECT event_id FROM photos WHERE photo_id=1'))?.event_id === 4,
  },
  {
    name: 'move one photo to Trash',
    send: () => deletePhoto(request('DELETE'), photo(2)),
    applied: async () =>
      !(await one('SELECT 1 FROM photos WHERE photo_id=2')) &&
      !!(await one('SELECT 1 FROM photo_trash WHERE photo_id=2')),
  },
  {
    name: 'choose the album cover',
    send: () => chooseCover(request('PATCH'), photo(2)),
    applied: async () =>
      (await one('SELECT cover_photo_id FROM events WHERE event_id=1'))?.cover_photo_id === 2,
  },
  {
    name: 'correct a capture date',
    send: () => setDate(request('PATCH', { dateTaken: '2026-06-01T12:00:00-07:00' }), photo(1)),
    applied: async () =>
      (await one('SELECT date_taken FROM photos WHERE photo_id=1'))?.date_taken != null,
  },
  {
    name: 'restore a photo from Trash',
    send: () => restoreTrash(request('POST', { ids: [10] })),
    applied: async () =>
      (await one('SELECT event_id FROM photos WHERE photo_id=10'))?.event_id === 1 &&
      !(await one('SELECT 1 FROM photo_trash WHERE photo_id=10')),
  },
  {
    name: 'permanently delete a photo from Trash',
    send: () => purgeTrash(request('DELETE', { ids: [10], confirm: 'PERMANENTLY_DELETE' })),
    applied: async () =>
      !(await one('SELECT 1 FROM photo_trash WHERE photo_id=10')) &&
      // The stored files are queued for deletion, not left behind.
      (await rows("SELECT 1 FROM stage_cleanup WHERE path LIKE '%a-trashed.jpg'")).length === 3,
  },
]

describe.each(changes)('$name (Alice’s private album)', ({ send, applied }) => {
  it.each([
    ['its owner', ALICE],
    ['the main administrator', OWNER],
  ])('is carried out for %s', async (_who, caller) => {
    signIn(caller)
    expect(await applied()).toBe(false)
    expect((await send()).status).toBe(200)
    expect(await applied()).toBe(true)
  })
  it.each([
    ['a caller without a session', null, 401],
    // A private album does not exist as far as another member can tell.
    ['another member', BOB, 404],
    ['an administrator who is not the main administrator', ADMIN, 404],
    ['a read-only administrator', AUDITOR, 403],
  ] as const)('is refused for %s and changes nothing', async (_who, caller, status) => {
    signIn(caller)
    const before = await contents()
    expect((await send()).status).toBe(status)
    expect(await contents()).toBe(before)
  })
  it('is refused from another site even for the owner', async () => {
    signIn(ALICE)
    s.headers.set('origin', 'https://elsewhere.example')
    const before = await contents()
    expect((await send()).status).toBe(403)
    expect(await contents()).toBe(before)
  })
})

it('lets a member read but not change an album shared with every signed-in user', async () => {
  signIn(ALICE)
  const before = await contents()
  expect((await albumExists(request('HEAD'), album(3))).status).toBe(200)
  for (const response of [
    await editAlbum(request('PATCH', { eventName: 'Mine now' }), album(3)),
    await deleteAlbum(request('DELETE'), album(3)),
    await changeSharing(request('POST', { action: 'visibility', visibility: 'PRIVATE' }), album(3)),
    await bulk(request('POST', { action: 'trash', ids: [4] })),
    await deletePhoto(request('DELETE'), photo(4)),
    await chooseCover(request('PATCH'), photo(4)),
    // Nor may a member move their own photo into an album they cannot change.
    await bulk(request('POST', { action: 'move', ids: [1], eventId: 3 })),
  ])
    expect(response.status).toBe(403)
  // Another member's private album is not a possible destination either.
  expect((await bulk(request('POST', { action: 'move', ids: [1], eventId: 2 }))).status).toBe(404)
  // A selection that mixes the caller's photo with someone else's fails as a whole.
  expect((await bulk(request('POST', { action: 'trash', ids: [1, 3] }))).status).toBe(404)
  expect(await contents()).toBe(before)
})

it('keeps each member’s Trash to that member, and shows the main administrator all of it', async () => {
  const listed = async () =>
    ((await (await listTrash(request('GET'))).json()).files as { photoId: number }[]).map(
      (file) => file.photoId,
    )
  signIn(ALICE)
  expect(await listed()).toEqual([10])
  const before = await contents()
  // Bob's trashed photo cannot be restored or destroyed by Alice.
  expect((await restoreTrash(request('POST', { ids: [11] }))).status).toBe(404)
  expect(
    (await purgeTrash(request('DELETE', { ids: [11], confirm: 'PERMANENTLY_DELETE' }))).status,
  ).toBe(404)
  // Nor can Alice restore her own photo into the shared album or Bob's album.
  expect((await restoreTrash(request('POST', { ids: [10], eventId: 3 }))).status).toBe(403)
  expect((await restoreTrash(request('POST', { ids: [10], eventId: 2 }))).status).toBe(404)
  expect(await contents()).toBe(before)
  // "Empty Trash" empties only the caller's own.
  expect(
    (await purgeTrash(request('DELETE', { all: true, confirm: 'PERMANENTLY_DELETE' }))).status,
  ).toBe(200)
  expect(await rows('SELECT photo_id FROM photo_trash')).toEqual([{ photo_id: 11 }])
  signIn(BOB)
  expect(await listed()).toEqual([11])
  signIn(AUDITOR)
  expect(await listed()).toEqual([])
  signIn(OWNER)
  expect(await listed()).toEqual([11])
  signIn(null)
  expect((await listTrash(request('GET'))).status).toBe(401)
})

it('requires the confirmation phrase before anything is permanently deleted', async () => {
  signIn(ALICE)
  const before = await contents()
  expect((await purgeTrash(request('DELETE', { all: true }))).status).toBe(400)
  expect((await purgeTrash(request('DELETE', { ids: [10], confirm: 'yes' }))).status).toBe(400)
  expect(await contents()).toBe(before)
})

it('shows a private album only to its owner, people it is shared with and the main administrator', async () => {
  const exists = async (id: number) => (await albumExists(request('HEAD'), album(id))).status
  const review = (id: number, ids: string) =>
    reviewAlbum(request('GET', undefined, `/api/events/${id}/review?ids=${ids}`), album(id))
  signIn(ALICE)
  expect([await exists(1), await exists(2), await exists(3)]).toEqual([200, 404, 200])
  expect(
    ((await (await review(1, '1,2')).json()) as { photoId: number }[]).map((p) => p.photoId),
  ).toEqual([1, 2])
  // Asking for Bob's photo through Alice's own album returns nothing of Bob's.
  expect(await (await review(1, '3')).json()).toEqual([])
  expect((await review(2, '3')).status).toBe(404)
  expect(await (await readSharing(request('GET'), album(1))).json()).toMatchObject({
    owner: 'ALICE',
    visibility: 'PRIVATE',
    canEdit: true,
    mainAdmin: false,
  })
  for (const caller of [BOB, ADMIN, AUDITOR]) {
    signIn(caller)
    expect([await exists(1), (await review(1, '1')).status]).toEqual([404, 404])
    expect((await readSharing(request('GET'), album(1))).status).toBe(404)
  }
  signIn(OWNER)
  expect([await exists(1), await exists(2), (await review(2, '3')).status]).toEqual([200, 200, 200])
  signIn(null)
  expect([await exists(1), await exists(3), (await review(1, '1')).status]).toEqual([401, 401, 401])

  // Sharing with Bob gives him the album to read, and nothing to change.
  signIn(ALICE)
  expect(
    (await changeSharing(request('POST', { action: 'share', username: 'BOB' }), album(1))).status,
  ).toBe(200)
  signIn(BOB)
  expect([await exists(1), (await review(1, '1')).status]).toEqual([200, 200])
  const before = await contents()
  expect((await editAlbum(request('PATCH', { eventName: 'Bob was here' }), album(1))).status).toBe(
    403,
  )
  expect((await bulk(request('POST', { action: 'favorite', ids: [1] }))).status).toBe(403)
  expect(await contents()).toBe(before)
  // Revoking the share closes the album to him again at once.
  signIn(ALICE)
  expect(
    (await changeSharing(request('POST', { action: 'revoke', username: 'BOB' }), album(1))).status,
  ).toBe(200)
  signIn(BOB)
  expect(await exists(1)).toBe(404)
})

it('lets only the main administrator hand an album to another member', async () => {
  const transfer = () =>
    changeSharing(request('POST', { action: 'transfer', username: 'BOB' }), album(1))
  const owner = async () =>
    (await one('SELECT owner_username FROM events WHERE event_id=1'))?.owner_username
  signIn(ALICE)
  expect((await transfer()).status).toBe(403)
  expect(await owner()).toBe('ALICE')
  signIn(OWNER)
  expect((await transfer()).status).toBe(200)
  expect(await owner()).toBe('BOB')
  // The former owner has lost the album; the new owner can change it.
  signIn(ALICE)
  expect((await albumExists(request('HEAD'), album(1))).status).toBe(404)
  signIn(BOB)
  expect((await editAlbum(request('PATCH', { eventName: 'Now Bob’s' }), album(1))).status).toBe(200)
})

it('rejects a malformed selection or date before changing anything', async () => {
  signIn(ALICE)
  const before = await contents()
  const tooMany = Array.from({ length: 201 }, (_, index) => index + 1)
  expect((await bulk(request('POST', { action: 'favorite', ids: tooMany }))).status).toBe(400)
  expect((await bulk(request('POST', { action: 'favorite', ids: [-1] }))).status).toBe(400)
  expect((await bulk(request('POST', { action: 'shred', ids: [1] }))).status).toBe(400)
  for (const dateTaken of ['bad', '2026-01-01T12:00:00', '2026-02-30T12:00:00Z', 123, undefined])
    expect((await setDate(request('PATCH', { dateTaken }), photo(1))).status).toBe(400)
  expect(await contents()).toBe(before)
})

// This file's other cases mean what they say only if requests really run under row-level
// security, so the test setup itself is checked: a request's own SQL is confined to the
// caller, whatever the route code above it does.
it('runs a request’s SQL as the row-secured web login, confined to the signed-in caller', async () => {
  const asRequest = withDatabaseRequest((sql: string) => pgQuery<Record<string, unknown>>(sql))
  signIn(ALICE)
  expect(
    await asRequest('SELECT current_user AS login, session_user<>current_user AS switched'),
  ).toEqual([{ login: 'personal_photos_app', switched: true }])
  expect(await asRequest('SELECT event_id FROM events ORDER BY event_id')).toEqual([
    { event_id: 1 },
    { event_id: 3 },
    { event_id: 4 },
  ])
  // A direct write to Bob's album or the shared album matches no row Alice may change.
  expect(
    await asRequest(
      "UPDATE events SET event_name='taken' WHERE event_id IN (2,3) RETURNING event_id",
    ),
  ).toEqual([])
  await expect(
    asRequest("INSERT INTO photos(event_id,source_filename) VALUES(2,'planted.jpg')"),
  ).rejects.toThrow(/row-level security/)
  signIn(AUDITOR)
  expect(await asRequest('SELECT event_id FROM events ORDER BY event_id')).toEqual([
    { event_id: 3 },
  ])
  signIn(OWNER)
  expect((await asRequest('SELECT event_id FROM events')).length).toBe(4)
  signIn(null)
  await expect(asRequest('SELECT event_id FROM events')).rejects.toMatchObject({ status: 401 })
  expect(await rows("SELECT 1 FROM events WHERE event_name='taken'")).toEqual([])
})
