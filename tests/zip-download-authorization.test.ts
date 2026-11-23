// A ZIP download can run for a long time, so what it may contain is decided file by file
// from live state, not from the list read when it began. Each case starts a real download
// of files A, B and C, holds A's original open in storage, changes the database while A is
// still streaming, lets A finish and then reads the bytes the client received.
//
// The real route handlers, authorization code, database layer and row-level security run
// (see fixtures/route-database). Only storage is replaced: signed URLs and `fetch`.
import {
  APP_ORIGIN,
  type Caller,
  callerHeaders,
  createRouteDatabase,
  DATABASE_ENV,
  snowflakeRoleRows,
} from './fixtures/route-database'
import type { PGlite } from '@electric-sql/pglite'
import { createHash } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
    throw new Error('Storage is reached only through the signed URLs replaced below')
  },
}))
vi.mock('@/lib/media/image-urls', () => ({
  getPresignedUrl: async (path: string) => `https://storage.invalid/${path}`,
  invalidateMediaUrl: () => {},
}))
import { GET as memberZip } from '@/app/api/photos/download/route'
import { GET as publicZip } from '@/app/share/[token]/download/route'
import { closePool } from '@/lib/postgres'

const ALICE: Caller = { username: 'ALICE', roles: ['viewer'] }
const BOB: Caller = { username: 'BOB', roles: ['viewer'] }
function signIn(caller: Caller | null) {
  s.caller = caller
  s.headers = callerHeaders(caller)
}

// Photos 1, 2 and 3 are files A, B and C. Each original has bytes found nowhere else.
const A = 'bytes-of-original-A:'.repeat(64)
const B = 'bytes-of-original-B:'.repeat(64)
const C = 'bytes-of-original-C:'.repeat(64)
const ORIGINALS: Record<string, string> = {
  'originals/a.jpg': A,
  'originals/b.jpg': B,
  'originals/c.jpg': C,
}
const TOKEN = 't'.repeat(43)
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex')

/** Storage paths requested so far, in order. */
let opened: string[] = []
/** Lets the held original of A finish. */
let finishA: () => void = () => {}
/** SQL to run when storage is asked for a path, before storage answers. */
let whileStorageAnswers: Record<string, string> = {}

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
  opened = []
  whileStorageAnswers = {}
  // Album 1 is Alice's, private, shared with Bob, and has a public link that allows
  // downloads. Album 4 is Alice's and private to her. Album 3 is open to every member.
  await s.db.exec(`DELETE FROM album_public_links;DELETE FROM album_shares;DELETE FROM photo_trash;
 DELETE FROM photos;DELETE FROM events;DELETE FROM search_queue;DELETE FROM stage_cleanup;
 DELETE FROM gallery_main_admins;DELETE FROM gallery_access_objects;
 INSERT INTO gallery_main_admins(username) VALUES('OWNER');
 INSERT INTO gallery_access_objects(kind,name,marker,display_name,created_by,state) VALUES
  ('user','ALICE','11111111-1111-4111-8111-111111111111','Alice','OWNER','ready'),
  ('user','BOB','22222222-2222-4222-8222-222222222222','Bob','OWNER','ready');
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES
  (1,1,'Shared trip','alice','ALICE','PRIVATE'),(3,3,'Everyone','everyone','OWNER','GALLERY'),
  (4,4,'Alice private','alice-2','ALICE','PRIVATE');
 INSERT INTO album_shares(event_id,username,created_by) VALUES(1,'BOB','ALICE');
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path,display_stage_path,thumbnail_stage_path) VALUES
  (1,1,'a.jpg','photo','READY','originals/a.jpg','display/a.jpg','thumbnails/a.jpg'),
  (2,1,'b.jpg','photo','READY','originals/b.jpg','display/b.jpg','thumbnails/b.jpg'),
  (3,1,'c.jpg','photo','READY','originals/c.jpg','display/c.jpg','thumbnails/c.jpg');
 INSERT INTO album_public_links(id,event_id,token_hash,owner_username,created_by,expires_at,allow_downloads) VALUES
  ('11111111-1111-4111-8111-111111111111',1,'${TOKEN_HASH}','ALICE','ALICE',now()+interval '1 hour',true);`)
  // Storage: A sends its first half and stays open until the test releases it; the other
  // originals are returned whole.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname.slice(1)
      opened.push(path)
      if (whileStorageAnswers[path]) await s.db.exec(whileStorageAnswers[path])
      const bytes = Buffer.from(ORIGINALS[path])
      if (path !== 'originals/a.jpg') return new Response(bytes)
      const half = bytes.length / 2
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.subarray(0, half))
            finishA = () => {
              controller.enqueue(bytes.subarray(half))
              controller.close()
            }
          },
        }),
      )
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

const startPublic = () =>
  publicZip(new Request(`${APP_ORIGIN}/share/${TOKEN}/download`), {
    params: Promise.resolve({ token: TOKEN }),
  })
const startMember = (ids = [1, 2, 3]) =>
  memberZip(new Request(`${APP_ORIGIN}/api/photos/download?ids=${ids.join(',')}`))

/**
 * Changes the database while A is still streaming, then reads everything the client
 * receives. `failed` is true when the transfer was cut off instead of completing.
 */
async function changeWhileStreaming(response: Response, change: string) {
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const chunks: Uint8Array[] = []
  // The archive has begun and A's original is open; nothing else has been requested.
  const first = await reader.read()
  expect(first.done).toBe(false)
  chunks.push(first.value!)
  expect(opened).toEqual(['originals/a.jpg'])
  await s.db.exec(change)
  finishA()
  let failed = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(next.value)
    }
  } catch {
    failed = true
  }
  const received = Buffer.concat(chunks)
  return { received, failed, files: () => unzipSync(received) }
}
/** What the owner's actions do to the rows; the original's storage path never changes. */
const MOVE_B_TO_PRIVATE_ALBUM = 'UPDATE photos SET event_id=4 WHERE photo_id=2'
const TRASH_B = `INSERT INTO photo_trash(photo_id,photo_data,album_name)
 SELECT p.photo_id,to_jsonb(p),e.event_name FROM photos p JOIN events e USING(event_id) WHERE p.photo_id=2;
 DELETE FROM photos WHERE photo_id=2`

/** A complete, readable archive of A and C in which B's bytes appear nowhere. */
function expectArchiveWithoutB(result: Awaited<ReturnType<typeof changeWhileStreaming>>) {
  expect(result.failed).toBe(false)
  const files = result.files()
  expect(Object.keys(files)).toEqual(['1-a.jpg', '3-c.jpg'])
  expect(strFromU8(files['1-a.jpg'])).toBe(A)
  expect(strFromU8(files['3-c.jpg'])).toBe(C)
  expect(result.received.includes(Buffer.from('bytes-of-original-B'))).toBe(false)
  // B's original was never requested from storage.
  expect(opened).toEqual(['originals/a.jpg', 'originals/c.jpg'])
}
/** The transfer was cut off: no bytes of B or C were sent and neither was requested. */
function expectStopped(result: Awaited<ReturnType<typeof changeWhileStreaming>>) {
  expect(result.failed).toBe(true)
  expect(result.received.includes(Buffer.from('bytes-of-original-B'))).toBe(false)
  expect(result.received.includes(Buffer.from('bytes-of-original-C'))).toBe(false)
  expect(opened).toEqual(['originals/a.jpg'])
}

describe('public link ZIP', () => {
  it('contains every file when nothing changes during the transfer', async () => {
    const result = await changeWhileStreaming(await startPublic(), 'SELECT 1')
    expect(result.failed).toBe(false)
    const files = result.files()
    expect(Object.keys(files)).toEqual(['1-a.jpg', '2-b.jpg', '3-c.jpg'])
    expect(strFromU8(files['2-b.jpg'])).toBe(B)
  })

  it('leaves out a file moved to a private album while an earlier file streams', async () => {
    expectArchiveWithoutB(await changeWhileStreaming(await startPublic(), MOVE_B_TO_PRIVATE_ALBUM))
  })

  it('leaves out a file moved to Trash while an earlier file streams', async () => {
    expectArchiveWithoutB(await changeWhileStreaming(await startPublic(), TRASH_B))
  })

  it('leaves out a file that stops being ready while an earlier file streams', async () => {
    expectArchiveWithoutB(
      await changeWhileStreaming(
        await startPublic(),
        "UPDATE photos SET ingest_status='PROCESSING' WHERE photo_id=2",
      ),
    )
  })

  it('leaves out a file removed from the selection of a selected-photos link', async () => {
    await s.db.exec("UPDATE album_public_links SET photo_ids='{1,2,3}'")
    expectArchiveWithoutB(
      await changeWhileStreaming(
        await startPublic(),
        "UPDATE album_public_links SET photo_ids='{1,3}'",
      ),
    )
  })

  it('keeps honouring a selection: an unselected file never enters the archive', async () => {
    await s.db.exec("UPDATE album_public_links SET photo_ids='{1,3}'")
    expectArchiveWithoutB(await changeWhileStreaming(await startPublic(), 'SELECT 1'))
  })

  it('stops the transfer when the link is revoked while a file streams', async () => {
    expectStopped(
      await changeWhileStreaming(
        await startPublic(),
        'UPDATE album_public_links SET revoked_at=now()',
      ),
    )
  })

  it('stops the transfer when original downloads are disabled while a file streams', async () => {
    expectStopped(
      await changeWhileStreaming(
        await startPublic(),
        'UPDATE album_public_links SET allow_downloads=false',
      ),
    )
  })

  it('stops the transfer when the link expires while a file streams', async () => {
    expectStopped(
      await changeWhileStreaming(
        await startPublic(),
        "UPDATE album_public_links SET expires_at=now()-interval '1 second'",
      ),
    )
  })

  it('leaves out a file removed after storage answered and before its bytes are appended', async () => {
    whileStorageAnswers = { 'originals/b.jpg': MOVE_B_TO_PRIVATE_ALBUM }
    const result = await changeWhileStreaming(await startPublic(), 'SELECT 1')
    expect(result.failed).toBe(false)
    expect(Object.keys(result.files())).toEqual(['1-a.jpg', '3-c.jpg'])
    expect(result.received.includes(Buffer.from('bytes-of-original-B'))).toBe(false)
  })

  it('stops the transfer when the link is revoked after storage answered', async () => {
    whileStorageAnswers = { 'originals/b.jpg': 'UPDATE album_public_links SET revoked_at=now()' }
    const result = await changeWhileStreaming(await startPublic(), 'SELECT 1')
    expect(result.failed).toBe(true)
    expect(result.received.includes(Buffer.from('bytes-of-original-B'))).toBe(false)
    expect(opened).toEqual(['originals/a.jpg', 'originals/b.jpg'])
  })

  it('refuses the download when no file remains by the time it starts', async () => {
    whileStorageAnswers = { 'originals/a.jpg': 'UPDATE photos SET event_id=4' }
    const response = await startPublic()
    expect(response.status).toBe(404)
    expect(opened).toEqual(['originals/a.jpg'])
  })
})

describe('signed-in ZIP', () => {
  it('contains every file when nothing changes during the transfer', async () => {
    signIn(BOB)
    const result = await changeWhileStreaming(await startMember(), 'SELECT 1')
    expect(result.failed).toBe(false)
    expect(Object.keys(result.files())).toEqual(['1-a.jpg', '2-b.jpg', '3-c.jpg'])
  })

  it('leaves out a file moved to an album the caller cannot read', async () => {
    signIn(BOB)
    expectArchiveWithoutB(await changeWhileStreaming(await startMember(), MOVE_B_TO_PRIVATE_ALBUM))
  })

  it('leaves out a file moved to Trash while an earlier file streams', async () => {
    signIn(BOB)
    expectArchiveWithoutB(await changeWhileStreaming(await startMember(), TRASH_B))
  })

  it('leaves out every remaining file once the album is no longer shared with the caller', async () => {
    signIn(BOB)
    const result = await changeWhileStreaming(
      await startMember(),
      "DELETE FROM album_shares WHERE event_id=1 AND username='BOB'",
    )
    expect(result.failed).toBe(false)
    expect(Object.keys(result.files())).toEqual(['1-a.jpg'])
    expect(result.received.includes(Buffer.from('bytes-of-original-B'))).toBe(false)
    expect(result.received.includes(Buffer.from('bytes-of-original-C'))).toBe(false)
    expect(opened).toEqual(['originals/a.jpg'])
  })

  it('leaves out a file removed after storage answered and before its bytes are appended', async () => {
    signIn(BOB)
    whileStorageAnswers = { 'originals/b.jpg': TRASH_B }
    const result = await changeWhileStreaming(await startMember(), 'SELECT 1')
    expect(result.failed).toBe(false)
    expect(Object.keys(result.files())).toEqual(['1-a.jpg', '3-c.jpg'])
    expect(result.received.includes(Buffer.from('bytes-of-original-B'))).toBe(false)
  })

  it('keeps a file moved to another album the caller can still read', async () => {
    // Bob can read album 3 (open to every member); Alice can read her own album 4.
    signIn(BOB)
    const toOpenAlbum = await changeWhileStreaming(
      await startMember(),
      'UPDATE photos SET event_id=3 WHERE photo_id=2',
    )
    expect(Object.keys(toOpenAlbum.files())).toEqual(['1-a.jpg', '2-b.jpg', '3-c.jpg'])
    await s.db.exec('UPDATE photos SET event_id=1 WHERE photo_id=2')
    opened = []
    signIn(ALICE)
    const toOwnAlbum = await changeWhileStreaming(await startMember(), MOVE_B_TO_PRIVATE_ALBUM)
    expect(strFromU8(toOwnAlbum.files()['2-b.jpg'])).toBe(B)
  })
})
