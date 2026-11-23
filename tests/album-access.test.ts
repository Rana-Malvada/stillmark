import { createTestDatabase, readSqlFile } from './fixtures/test-database'
import { installUploadQueue } from './fixtures/install-upload-queue'

const chunkObjects = vi.hoisted(() => new Map<string, Buffer>())
vi.mock('@/lib/upload/upload-chunk-stage', () => ({
  prepareUploadChunkUrls: async () => {},
  storeUploadChunk: async (id: string, index: number, data: Buffer) => {
    const path = `upload-chunks/${id}/${index}`
    chunkObjects.set(path, Buffer.from(data))
    return path
  },
  readUploadChunk: async (path: string) => {
    const data = chunkObjects.get(path)
    if (!data) throw Error('Missing stage chunk')
    return data
  },
}))
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const s = vi.hoisted(() => ({
  db: null as any,
  tx: null as any,
  caller: { username: 'ALICE', role: 'viewer' as 'viewer' | 'admin' | 'admin_readonly' } as {
    username: string
    role: 'viewer' | 'admin' | 'admin_readonly'
    canManagePersonal?: boolean
    appOwner?: boolean
  },
  url: vi.fn(),
  sync: vi.fn(),
  process: vi.fn(),
  prepare: vi.fn(),
}))
vi.mock('@/lib/identity/auth', () => ({
  getCallerIdentity: vi.fn(async () => s.caller),
  requireAuth: async () => s.caller,
  requireSameOrigin: vi.fn(),
}))
vi.mock('@/lib/postgres', () => ({
  getDatabaseIdentity: async () => ({
    username: s.caller.username,
    mainAdmin:
      (s.caller.appOwner === true ||
        !!(
          await (s.tx ?? s.db).query('SELECT username FROM gallery_main_admins WHERE username=$1', [
            s.caller.username,
          ])
        ).rows[0]) &&
      s.caller.role !== 'admin_readonly',
  }),
  pgReadIdentity: async (_identity: unknown, fn: () => Promise<unknown>) => {
    if (s.tx) throw new Error('Read identity cannot replace an active transaction')
    return fn()
  },
  withAdvisoryLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
  pgAuthEpoch: async () => '1',
  pgQuery: async (q: string, p?: unknown[]) => (await (s.tx ?? s.db).query(q, p)).rows,
  pgQueryOne: async (q: string, p?: unknown[]) =>
    (await (s.tx ?? s.db).query(q, p)).rows[0] ?? null,
  pgTransaction: async (fn: () => Promise<unknown>) =>
    s.tx
      ? fn()
      : s.db.transaction(async (tx: any) => {
          s.tx = tx
          try {
            return await fn()
          } finally {
            s.tx = null
          }
        }),
}))
vi.mock('@/lib/observability/activity-action', () => ({ trackAction: vi.fn() }))
vi.mock('@/lib/media/image-urls', async () => ({
  ...(await vi.importActual<typeof import('@/lib/media/image-urls')>('@/lib/media/image-urls')),
  getPresignedUrl: s.url,
}))
vi.mock('@/lib/snowflake', () => ({
  getSnowflakeBaseUrl: () => 'https://example.snowflakecomputing.com',
  getRestApiAuthHeader: () => 'Bearer test',
  querySnowflake: vi.fn(),
  querySnowflakeStorage: vi.fn(),
}))
vi.mock('@/lib/search/search-sync', () => ({ syncSearch: s.sync }))
// People search has its own row-security tests (people-search.test.ts); this schema has no People tables.
vi.mock('@/lib/people/people-search', async (actual) => ({
  ...(await actual<typeof import('@/lib/people/people-search')>()),
  resolvePeople: async (query: string) => ({ people: [], remainder: query }),
  peopleById: async () => [],
  suggestPeople: async () => [],
}))
vi.mock('@/lib/upload/upload-processing', () => ({
  processImage: s.process,
  processVideo: s.process,
  prepareImage: async (...args: any[]) => {
    await s.prepare()
    return async () => s.process(...args)
  },
  prepareVideo: async (...args: any[]) => {
    await s.prepare()
    return async () => s.process(...args)
  },
  SUPPORTED_EXTS: new Set(['jpg', 'mp4']),
  VIDEO_EXTS: new Set(['mp4']),
}))
import {
  accessibleAlbumIds,
  albumCaller,
  albumMutation,
  requireAlbumAccess,
  requirePhotoAccess,
} from '@/lib/albums/album-access'
import { search } from '@/lib/search'
import { createEvent, deleteEvent } from '@/lib/albums/events'
import { getPhotoViewerPage } from '@/lib/photos'
import { GET as media } from '@/app/api/images/route'
import { GET as download } from '@/app/api/photos/download/route'
import { POST as sharing } from '@/app/api/events/[eventId]/sharing/route'
import { POST as bulk } from '@/app/api/photos/bulk/route'
import { DELETE as purge, POST as restore, GET as trash } from '@/app/api/trash/route'
import { POST as sync } from '@/app/api/search-sync/route'
import { GET as albums } from '@/app/api/events/route'
import { GET as favorites } from '@/app/api/favorites/route'
import { completeUpload, saveChunk } from '@/lib/upload/upload-sessions'

const ctx = (eventId: number) => ({ params: Promise.resolve({ eventId: String(eventId) }) })
const req = (body: object) =>
  new Request('https://app/api/test', { method: 'POST', body: JSON.stringify(body) })
const upload = '11111111-1111-4111-8111-111111111111'
beforeAll(async () => {
  s.db = await createTestDatabase({
    schema: false,
    steps: [
      {
        sql: 'CREATE TABLE search_enrichment(photo_id int PRIMARY KEY,source_path text,status text,ocr_text text)',
      },
      'setup/02-postgres.sql',
      'setup/03-add-metadata-columns.sql',
      'setup/04-production.sql',
      'setup/06-video-600mib.sql',
      'setup/07-photo-trash.sql',
      'setup/09-photo-labels.sql',
      'setup/10-access-management.sql',
      'setup/14-auth0-registry.sql',
      'setup/19-album-ownership.sql',
      'setup/20-personal-folders.sql',
      'setup/21-video-4gib.sql',
      {
        sql: 'ALTER TABLE events ADD COLUMN archived_account boolean NOT NULL DEFAULT false; CREATE TABLE deleted_accounts(name text,display_name text)',
      },
      'setup/34-stage-upload-chunks.sql',
      'setup/65-upload-completion-claims.sql',
      {
        sql: 'CREATE TABLE upload_start_limits(owner text PRIMARY KEY,window_start timestamptz NOT NULL DEFAULT now(),starts integer NOT NULL)',
      },
      'setup/26-travel-place-cache.sql',
      { file: 'setup/40-user-folder-state.sql', withoutGrants: true },
      { file: 'setup/41-album-public-links.sql', withoutGrants: true },
      // This suite omits People tables; the capability function is exercised separately.
      { sql: readSqlFile('202610202000_public_album_details').split('-- Return only')[0] },
      { sql: 'ALTER TABLE album_public_links ADD COLUMN photo_ids integer[]' },
      { file: 'setup/57-video-playback.sql', withoutGrants: true },
      'setup/58-adaptive-playback.sql',
      {
        sql: 'CREATE ROLE personal_photos_app; CREATE SCHEMA photo_security; CREATE POLICY app_read ON video_playback FOR SELECT USING(true)',
      },
      '202610062200_media_lookup_indexes',
      '202610062230_video_path_catalog',
      { file: 'setup/39-album-locations.sql', withoutGrants: true },
    ],
  })
}, 30_000)
afterAll(async () => s.db?.close())
beforeAll(async () => {
  await s.db.exec(`CREATE SCHEMA IF NOT EXISTS photo_security;
 CREATE OR REPLACE FUNCTION photo_security.active_upload_count() RETURNS bigint LANGUAGE sql AS $$SELECT count(*) FROM upload_sessions WHERE result IS NULL$$;
 CREATE OR REPLACE FUNCTION photo_security.active_username(who text) RETURNS boolean LANGUAGE sql AS $$SELECT EXISTS(SELECT FROM gallery_access_objects WHERE kind='user' AND name=who AND state='ready' AND NOT deleting) OR EXISTS(SELECT FROM gallery_main_admins WHERE username=who)$$;`)
  await installUploadQueue(s.db)
})
beforeEach(async () => {
  vi.resetAllMocks()
  s.caller = { username: 'ALICE', role: 'viewer' }
  s.process.mockResolvedValue({ status: 'skipped' })
  vi.stubGlobal('fetch', vi.fn())
  await s.db
    .exec(`TRUNCATE video_playback,upload_start_limits,folders,events,photos,photo_trash,upload_jobs,upload_files,upload_sessions,upload_chunks,search_queue,stage_cleanup,gallery_access_objects RESTART IDENTITY CASCADE;
 INSERT INTO events(sort_order,event_name,source_folder,owner_username,visibility) VALUES
 (1,'Alice private','alice','ALICE','PRIVATE'),(2,'Bob private','bob','BOB','PRIVATE'),(3,'Shared collection','shared','EXAMPLEADMIN','GALLERY');
 INSERT INTO photos(event_id,source_filename,original_stage_path,thumbnail_stage_path,ingest_status,favorite) VALUES
 (1,'a.jpg','originals/a.jpg','thumbnails/a.jpg','READY',true),(2,'b.jpg','originals/b.jpg','thumbnails/b.jpg','READY',true),(3,'c.jpg','originals/c.jpg','thumbnails/c.jpg','READY',true);
 INSERT INTO gallery_access_objects(kind,name,marker,display_name,created_by,state) VALUES
 ('user','ALICE','11111111-1111-4111-8111-111111111111','Alice','EXAMPLEADMIN','ready'),('user','BOB','22222222-2222-4222-8222-222222222222','Bob','EXAMPLEADMIN','ready');`)
})
it('owners see their private albums and the shared collection; ordinary admins cannot bypass privacy', async () => {
  expect(await accessibleAlbumIds()).toEqual([1, 3])
  expect((await requireAlbumAccess(1, true)).canEdit).toBe(true)
  await expect(requireAlbumAccess(2)).rejects.toMatchObject({ status: 404 })
  await expect(requireAlbumAccess(3, true)).rejects.toMatchObject({ status: 403 })
  s.caller.role = 'admin'
  expect((await albumCaller()).mainAdmin).toBe(false)
  await expect(requirePhotoAccess(2, true)).rejects.toMatchObject({ status: 404 })
  const response = await albums(new Request('https://app/api/events?paged=true'))
  expect((await response.json()).items.map((e: any) => [e.eventId, e.canEdit])).toEqual([
    [1, true],
    [3, false],
  ])
  const favoritePage = await favorites(new Request('https://app/api/favorites?paged=true'))
  expect((await favoritePage.json()).items.map((p: any) => p.photoId)).toEqual([1, 3])
})
it('photo ACL lookup preserves owner, shared-read, revocation and read-only rules', async () => {
  expect((await requirePhotoAccess(1, true)).canEdit).toBe(true)
  await expect(requirePhotoAccess(999)).rejects.toMatchObject({ status: 404 })
  await expect(requirePhotoAccess(2)).rejects.toMatchObject({ status: 404 })
  await s.db.query(
    "INSERT INTO album_shares(event_id,username,created_by) VALUES (2,'ALICE','BOB')",
  )
  expect((await requirePhotoAccess(2)).shared).toBe(true)
  await expect(requirePhotoAccess(2, true)).rejects.toMatchObject({ status: 403 })
  await s.db.query("DELETE FROM album_shares WHERE event_id=2 AND username='ALICE'")
  await expect(requirePhotoAccess(2)).rejects.toMatchObject({ status: 404 })
  s.caller.role = 'admin_readonly'
  await expect(requirePhotoAccess(1, true)).rejects.toMatchObject({ status: 403 })
  s.caller = { username: 'EXAMPLEADMIN', role: 'admin' }
  expect((await requirePhotoAccess(2, true)).canEdit).toBe(true)
})
it('main admin sees and can edit all albums; a read-only role never writes even its own album', async () => {
  s.caller = { username: 'EXAMPLEADMIN', role: 'admin' }
  expect(await accessibleAlbumIds()).toEqual([1, 2, 3])
  expect((await requireAlbumAccess(2, true)).canEdit).toBe(true)
  s.caller = { username: 'ALICE', role: 'admin_readonly' }
  expect((await requireAlbumAccess(1)).canEdit).toBe(false)
  await expect(
    albumMutation(async () => {
      throw Error('must not execute')
    }),
  ).rejects.toMatchObject({ status: 403 })
  for (const action of ['favorite', 'trash', 'move'])
    expect((await bulk(req({ ids: [1], action, eventId: 3 }))).status).toBe(403)
})
it('combined Viewer and read-only Admin can manage owned albums without editing others or syncing', async () => {
  s.caller = { username: 'ALICE', role: 'admin_readonly', canManagePersonal: true }
  const { requireUploadUser } = await import('@/lib/albums/album-access')
  await expect(requireUploadUser()).resolves.toMatchObject({ canManagePersonal: true })
  expect((await requireAlbumAccess(1, true)).canEdit).toBe(true)
  await expect(requireAlbumAccess(3, true)).rejects.toMatchObject({ status: 403 })
  expect((await bulk(req({ ids: [1], action: 'favorite' }))).status).toBe(200)
  expect((await sync(req({}))).status).toBe(403)
})
it('shares grant read access only and revocation immediately removes media access', async () => {
  expect((await sharing(req({ action: 'share', username: 'bob' }), ctx(1))).status).toBe(200)
  s.caller.username = 'BOB'
  expect(await accessibleAlbumIds()).toEqual([1, 2, 3])
  await expect(requireAlbumAccess(1, true)).rejects.toMatchObject({ status: 403 })
  s.caller.username = 'ALICE'
  expect((await sharing(req({ action: 'revoke', username: 'BOB' }), ctx(1))).status).toBe(200)
  s.caller.username = 'BOB'
  const response = await media(new Request('https://app/api/images?path=originals/a.jpg'))
  expect(response.status).toBe(404)
  expect(s.url).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})
it('blocks guessed thumbnail, original, video-range and ZIP access before storage calls', async () => {
  for (const path of ['originals/b.jpg', 'thumbnails/b.jpg'])
    expect(
      (
        await media(
          new Request(`https://app/api/images?path=${path}`, { headers: { range: 'bytes=0-100' } }),
        )
      ).status,
    ).toBe(404)
  expect((await download(new Request('https://app/api/photos/download?ids=1,2'))).status).toBe(404)
  expect(fetch).not.toHaveBeenCalled()
  expect(s.url).not.toHaveBeenCalled()
})
it('owners publish and unpublish only their own albums', async () => {
  const visibility = async (id: number) =>
    (await s.db.query('SELECT visibility FROM events WHERE event_id=$1', [id])).rows[0].visibility
  expect(
    (await sharing(req({ action: 'visibility', visibility: 'EVERYONE' }), ctx(1))).status,
  ).toBe(400)
  expect(await visibility(1)).toBe('PRIVATE')
  expect((await sharing(req({ action: 'visibility', visibility: 'GALLERY' }), ctx(1))).status).toBe(
    200,
  )
  expect(await visibility(1)).toBe('GALLERY')
  // Another member can now read it, but cannot change it or publish albums they cannot see.
  s.caller = { username: 'BOB', role: 'viewer' }
  expect((await requireAlbumAccess(1)).canEdit).toBe(false)
  expect((await sharing(req({ action: 'visibility', visibility: 'PRIVATE' }), ctx(1))).status).toBe(
    403,
  )
  expect((await sharing(req({ action: 'visibility', visibility: 'PRIVATE' }), ctx(3))).status).toBe(
    403,
  )
  expect(await visibility(1)).toBe('GALLERY')
  expect(await visibility(3)).toBe('GALLERY')
  // Ordinary and read-only administrators have no extra right over another owner's album.
  for (const role of ['admin', 'admin_readonly'] as const) {
    s.caller = { username: 'CAROL', role }
    expect(
      (await sharing(req({ action: 'visibility', visibility: 'GALLERY' }), ctx(2))).status,
    ).toBe(role === 'admin' ? 404 : 403)
  }
  expect(await visibility(2)).toBe('PRIVATE')
  s.caller = { username: 'ALICE', role: 'viewer' }
  expect((await sharing(req({ action: 'visibility', visibility: 'PRIVATE' }), ctx(1))).status).toBe(
    200,
  )
  expect(await visibility(1)).toBe('PRIVATE')
  s.caller = { username: 'BOB', role: 'viewer' }
  await expect(requireAlbumAccess(1)).rejects.toMatchObject({ status: 404 })
  // The main admin retains the right for any album.
  s.caller = { username: 'EXAMPLEADMIN', role: 'admin' }
  expect((await sharing(req({ action: 'visibility', visibility: 'GALLERY' }), ctx(2))).status).toBe(
    200,
  )
  expect(await visibility(2)).toBe('GALLERY')
})
it('only the main admin can transfer ownership or Sync Search', async () => {
  for (const role of ['viewer', 'admin', 'admin_readonly'] as const) {
    s.caller.role = role
    expect((await sync(req({}))).status).toBe(403)
  }
  expect(s.sync).not.toHaveBeenCalled()
  s.caller.role = 'viewer'
  expect((await sharing(req({ action: 'transfer', username: 'BOB' }), ctx(1))).status).toBe(403)
  s.caller = { username: 'EXAMPLEADMIN', role: 'admin' }
  s.sync.mockResolvedValue({ photos: { synced: 0 } })
  expect((await sync(req({}))).status).toBe(200)
  expect(s.sync).toHaveBeenCalledWith({ force: true, full: false })
  expect((await sharing(req({ action: 'transfer', username: 'BOB' }), ctx(1))).status).toBe(200)
  s.caller = { username: 'ALICE', role: 'viewer' }
  await expect(requireAlbumAccess(1)).rejects.toMatchObject({ status: 404 })
  s.caller.username = 'BOB'
  expect((await requireAlbumAccess(1, true)).canEdit).toBe(true)
})
it('rejects unowned source and destination moves atomically', async () => {
  expect((await bulk(req({ action: 'move', ids: [1, 2], eventId: 1 }))).status).toBe(404)
  expect((await bulk(req({ action: 'move', ids: [1], eventId: 3 }))).status).toBe(403)
  expect((await s.db.query('SELECT event_id FROM photos WHERE photo_id=1')).rows[0].event_id).toBe(
    1,
  )
})
it('preserves trash ownership after deleting albums and scopes empty-trash to its owner', async () => {
  await albumMutation(async (c) => {
    await requireAlbumAccess(1, true, c)
    await deleteEvent(1)
  })
  s.caller.username = 'BOB'
  await albumMutation(async () => deleteEvent(2))
  s.caller.username = 'ALICE'
  expect(
    (await (await trash(new Request('https://app/api/trash'))).json()).files.map(
      (f: any) => f.photoId,
    ),
  ).toEqual([1])
  expect((await restore(req({ ids: [2], eventId: 3 }))).status).toBe(404)
  expect((await restore(req({ ids: [1], eventId: 3 }))).status).toBe(403)
  expect((await purge(req({ all: true, confirm: 'PERMANENTLY_DELETE' }))).status).toBe(200)
  expect((await s.db.query('SELECT photo_id FROM photo_trash')).rows).toEqual([{ photo_id: 2 }])
})
it('creates private albums with explicit owners and keeps privacy on repeat migration', async () => {
  const id = await createEvent({
    ownerUsername: 'BOB',
    sourceFolder: 'new',
    eventName: 'New',
    sortOrder: 0,
    eventMonth: null,
    eventYear: null,
    location: null,
  })
  await s.db.exec(readFileSync('setup/19-album-ownership.sql', 'utf8'))
  expect(
    (await s.db.query('SELECT owner_username,visibility FROM events WHERE event_id=$1', [id]))
      .rows[0],
  ).toEqual({ owner_username: 'BOB', visibility: 'PRIVATE' })
  await expect(requireAlbumAccess(id)).rejects.toMatchObject({ status: 404 })
})
async function chunk(owner: string, id = upload) {
  const f = new FormData()
  f.set('uploadId', id)
  f.set('totalChunks', '1')
  f.set('chunkIndex', '0')
  f.set('chunk', new File(['bytes'], 'a.jpg'))
  await saveChunk(owner, f)
}
it('rejects uploads into someone else’s album before processing media', async () => {
  await chunk('ALICE')
  await expect(
    completeUpload('ALICE', {
      uploadId: upload,
      totalChunks: 1,
      fileName: 'a.jpg',
      folderName: 'bob',
      eventId: 2,
    }),
  ).rejects.toMatchObject({ status: 404 })
  expect(s.process).not.toHaveBeenCalled()
})
it('enforces chunk, chunk-count, file and image size limits on the server', async () => {
  const { CHUNK_BYTES, MAX_CHUNKS, MAX_FILE_BYTES, MAX_IMAGE_BYTES } =
    await import('@/lib/upload/upload-limits')
  const send = (size: number, index = 0, total = 1, id = upload) => {
    const form = new FormData()
    form.set('uploadId', id)
    form.set('totalChunks', String(total))
    form.set('chunkIndex', String(index))
    form.set('chunk', new File([new Uint8Array(size)], 'a.jpg'))
    return saveChunk('ALICE', form)
  }
  const stored = async () =>
    (await s.db.query('SELECT count(*)::int AS n FROM upload_sessions')).rows[0].n
  // One byte over the chunk limit, an empty chunk, a short non-final chunk and too many chunks.
  await expect(send(CHUNK_BYTES + 1)).rejects.toMatchObject({ status: 413 })
  await expect(send(0)).rejects.toMatchObject({ status: 413 })
  await expect(send(CHUNK_BYTES - 1, 0, 2)).rejects.toMatchObject({ status: 400 })
  await expect(send(1, 0, MAX_CHUNKS + 1)).rejects.toMatchObject({ status: 400 })
  expect(await stored()).toBe(0)
  // Exactly the chunk limit is accepted.
  await send(CHUNK_BYTES, 0, 2)
  expect(await stored()).toBe(1)
  // A chunk that would take the file past the limit is refused, and the total is unchanged.
  await s.db.query('UPDATE upload_sessions SET bytes=$2 WHERE upload_id=$1', [
    upload,
    MAX_FILE_BYTES - 1,
  ])
  await expect(send(2, 1, 2)).rejects.toMatchObject({ status: 413 })
  expect(
    Number(
      (await s.db.query('SELECT bytes FROM upload_sessions WHERE upload_id=$1', [upload])).rows[0]
        .bytes,
    ),
  ).toBe(MAX_FILE_BYTES - 1)
  // An image one byte over the image limit is refused at completion, before any processing.
  await s.db.query('UPDATE upload_sessions SET bytes=$2 WHERE upload_id=$1', [
    upload,
    MAX_IMAGE_BYTES + 1,
  ])
  await expect(
    completeUpload('ALICE', {
      uploadId: upload,
      totalChunks: 2,
      fileName: 'a.jpg',
      folderName: 'alice',
      eventId: 1,
    }),
  ).rejects.toMatchObject({ status: 413 })
  expect(s.process).not.toHaveBeenCalled()
  expect(s.prepare).not.toHaveBeenCalled()
})
it('freezes only known upload details and still accepts sessions frozen before that rule', async () => {
  const { freezeUploadMetadata } = await import('@/lib/upload/upload-sessions')
  await chunk('ALICE')
  const details = {
    uploadId: upload,
    totalChunks: 1,
    fileName: 'a.jpg',
    folderName: 'alice',
    eventId: 1,
  }
  await freezeUploadMetadata('ALICE', {
    ...details,
    thumbnail: 'AAAA',
    queuedProcessing: true,
    junk: 'x'.repeat(200000),
  })
  const stored = async () =>
    (await s.db.query('SELECT metadata FROM upload_sessions WHERE upload_id=$1', [upload])).rows[0]
      .metadata
  expect(await stored()).toEqual(details)
  // Unknown keys are ignored, so changing them is not a metadata change; a real change still is.
  await freezeUploadMetadata('ALICE', { ...details, junk: 'different' })
  await expect(
    freezeUploadMetadata('ALICE', { ...details, fileName: 'b.jpg' }),
  ).rejects.toMatchObject({ status: 409 })
  await expect(
    freezeUploadMetadata('ALICE', { ...details, location: 'x'.repeat(9000) }),
  ).rejects.toMatchObject({ status: 413 })
  // A session frozen by an earlier version kept extra keys; a resumed upload must still match.
  await s.db.query('UPDATE upload_sessions SET metadata=$2::jsonb WHERE upload_id=$1', [
    upload,
    JSON.stringify({ ...details, sourceFolder: 'alice', legacy: true }),
  ])
  await freezeUploadMetadata('ALICE', details)
  expect(await stored()).toEqual(details)
})
it('refuses an unsupported or badly named file when it is queued, before any processing', async () => {
  const { enqueueUpload } = await import('@/lib/upload/upload-processing-jobs')
  await chunk('ALICE')
  const details = { uploadId: upload, totalChunks: 1, folderName: 'alice', eventId: 1 }
  const queued = async () =>
    (await s.db.query('SELECT count(*)::int AS n FROM upload_processing_jobs')).rows[0].n
  for (const [fileName, status] of [
    ['notes.exe', 415],
    ['../a.jpg', 400],
    ['', 400],
  ] as const)
    await expect(enqueueUpload({ ...details, fileName })).rejects.toMatchObject({ status })
  // A refused attempt leaves nothing frozen, so the corrected name is accepted afterwards.
  expect(
    (await s.db.query('SELECT metadata FROM upload_sessions WHERE upload_id=$1', [upload])).rows[0]
      .metadata,
  ).toBeNull()
  expect(await queued()).toBe(0)
  expect(s.process).not.toHaveBeenCalled()
  expect(s.prepare).not.toHaveBeenCalled()
})
it('isolates identical uploaded folder names for different users', async () => {
  await s.db.exec(
    "INSERT INTO folders(folder_name,owner_username) VALUES('Uploads','ALICE'),('Uploads','BOB')",
  )
  await chunk('ALICE')
  const first = await completeUpload('ALICE', {
    uploadId: upload,
    totalChunks: 1,
    fileName: 'a.jpg',
    folderName: 'Vacation',
    eventName: 'Vacation',
    folderId: 1,
  })
  s.caller.username = 'BOB'
  const other = '22222222-2222-4222-8222-222222222222'
  await chunk('BOB', other)
  const second = await completeUpload('BOB', {
    uploadId: other,
    totalChunks: 1,
    fileName: 'a.jpg',
    folderName: 'Vacation',
    eventName: 'Vacation',
    folderId: 2,
  })
  expect(second.eventId).not.toBe(first.eventId)
  expect(
    (
      await s.db.query(
        'SELECT owner_username,visibility FROM events WHERE event_id=ANY($1::int[])',
        [[first.eventId, second.eventId]],
      )
    ).rows,
  ).toEqual([
    { owner_username: 'ALICE', visibility: 'PRIVATE' },
    { owner_username: 'BOB', visibility: 'PRIVATE' },
  ])
})
it('rechecks ownership on completed-upload replay after transfer', async () => {
  await s.db.exec(
    "INSERT INTO folders(folder_name,owner_username) VALUES('Uploads','ALICE'); UPDATE events SET folder_id=1 WHERE event_id=1",
  )
  await chunk('ALICE')
  await completeUpload('ALICE', {
    uploadId: upload,
    totalChunks: 1,
    fileName: 'a.jpg',
    folderName: 'alice',
    eventId: 1,
  })
  await s.db.exec("UPDATE events SET owner_username='BOB' WHERE event_id=1")
  await expect(
    completeUpload('ALICE', {
      uploadId: upload,
      totalChunks: 1,
      fileName: 'a.jpg',
      folderName: 'alice',
      eventId: 1,
    }),
  ).rejects.toMatchObject({ status: 404 })
})

it('filters keyword search before results and semantic search both before ranking and when hydrating stale IDs', async () => {
  await s.db.exec("UPDATE photos SET ai_description='car' WHERE photo_id IN (1,2,3)")
  const options = { query: 'car', limit: 20, eventId: null, semantic: false }
  const ids = await accessibleAlbumIds()
  expect((await search('photo', options, ids)).results.map((p) => p.photoId)).toEqual([3, 1])
  expect(fetch).not.toHaveBeenCalled()
  vi.mocked(fetch).mockResolvedValue(Response.json({ results: [{ PHOTO_ID: 2 }, { PHOTO_ID: 1 }] }))
  expect(
    (await search('photo', { ...options, semantic: true }, ids)).results.map((p) => p.photoId),
  ).toEqual([1])
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).filter).toEqual({
    '@or': [{ '@eq': { EVENT_ID: 1 } }, { '@eq': { EVENT_ID: 3 } }],
  })
  await expect(search('photo', { ...options, eventId: 2 }, ids)).rejects.toMatchObject({
    status: 404,
  })
})
it('refuses sharing to missing or deleting accounts and denies non-owner sharing', async () => {
  expect((await sharing(req({ action: 'share', username: 'MISSING' }), ctx(1))).status).toBe(400)
  await s.db.exec("UPDATE gallery_access_objects SET deleting=true WHERE name='BOB'")
  expect((await sharing(req({ action: 'share', username: 'BOB' }), ctx(1))).status).toBe(400)
  expect((await sharing(req({ action: 'share', username: 'ALICE' }), ctx(3))).status).toBe(403)
})

it('personal folders support creation, assignment and deletion without crossing owner boundaries', async () => {
  const f = await import('@/app/api/folders/route')
  const { POST: createAlbum } = await import('@/app/api/events/route')
  const { PATCH: editAlbum } = await import('@/app/api/events/[eventId]/route')
  const response = await f.POST(req({ folderName: 'Trips', personal: true }))
  expect(response.status).toBe(200)
  const { folderId } = await response.json()
  expect(
    (await (await f.GET(new Request('https://app/api/folders'))).json()).find(
      (x: any) => x.folderId === folderId,
    ),
  ).toMatchObject({
    ownerUsername: 'ALICE',
    canEdit: true,
  })
  expect((await createAlbum(req({ eventName: 'New trip', folderId }))).status).toBe(201)
  expect((await editAlbum(req({ folderId }), ctx(1))).status).toBe(200)
  s.caller = { username: 'BOB', role: 'viewer' }
  expect(
    (await (await f.GET(new Request('https://app/api/folders'))).json()).some(
      (x: any) => x.folderId === folderId,
    ),
  ).toBe(false)
  expect((await f.PATCH(req({ folderId, folderName: 'Stolen' }))).status).toBe(403)
  expect((await editAlbum(req({ folderId }), ctx(2))).status).toBe(403)
  expect((await createAlbum(req({ eventName: 'Wrong folder', folderId }))).status).toBe(403)
  s.caller = { username: 'ALICE', role: 'admin_readonly' }
  expect((await f.DELETE(req({ folderId }))).status).toBe(403)
  s.caller = { username: 'ALICE', role: 'admin_readonly', canManagePersonal: true }
  expect((await f.DELETE(req({ folderId }))).status).toBe(200)
  expect(
    (await s.db.query('SELECT folder_id FROM events WHERE event_id=1')).rows[0].folder_id,
  ).toBe(null)
  expect((await s.db.query('SELECT count(*)::int n FROM photos')).rows[0].n).toBe(3)
})

it('assembles videos on disk and removes temporary data after processing', async () => {
  await s.db.exec(
    "INSERT INTO folders(folder_name,owner_username) VALUES('Uploads','ALICE'); UPDATE events SET folder_id=1 WHERE event_id=1",
  )
  const bytes = Buffer.from('0000ftyp0000video-data')
  const form = new FormData()
  form.set('uploadId', upload)
  form.set('totalChunks', '1')
  form.set('chunkIndex', '0')
  form.set('chunk', new File([bytes], 'clip.mp4'))
  await saveChunk('ALICE', form)
  let path = ''
  s.process.mockImplementation(async (source) => {
    path = source.path
    expect(Buffer.isBuffer(source)).toBe(false)
    expect(await source.read(0, bytes.length)).toEqual(bytes)
    expect(readFileSync(path)).toEqual(bytes)
    return { status: 'skipped' }
  })
  await completeUpload('ALICE', {
    uploadId: upload,
    totalChunks: 1,
    fileName: 'clip.mp4',
    folderName: 'alice',
    eventId: 1,
  })
  const { existsSync } = await import('node:fs')
  expect(existsSync(path)).toBe(false)
})
it('accepts 4 GiB session boundaries and rejects oversized sessions', async () => {
  await s.db.query(
    "INSERT INTO upload_sessions(upload_id,owner,total_chunks,bytes) VALUES($1,'ALICE',512,4294967296)",
    [upload],
  )
  await expect(
    s.db.query('UPDATE upload_sessions SET bytes=4294967297 WHERE upload_id=$1', [upload]),
  ).rejects.toMatchObject({ code: '23514' })
  await expect(
    s.db.query('UPDATE upload_sessions SET total_chunks=513 WHERE upload_id=$1', [upload]),
  ).rejects.toMatchObject({ code: '23514' })
})
it('allows four in-flight files per user and rejects a fifth', async () => {
  for (let i = 0; i < 5; i++) {
    const form = new FormData()
    form.set('uploadId', `11111111-1111-4111-8111-11111111111${i}`)
    form.set('totalChunks', '1')
    form.set('chunkIndex', '0')
    form.set('chunk', new File(['x'], 'x.jpg'))
    if (i < 4) await saveChunk('ALICE', form)
    else await expect(saveChunk('ALICE', form)).rejects.toMatchObject({ status: 429 })
  }
})

it('cleans the temporary video after processing fails and preserves resumable chunks', async () => {
  await s.db.exec(
    "INSERT INTO folders(folder_name,owner_username) VALUES('Uploads','ALICE'); UPDATE events SET folder_id=1 WHERE event_id=1",
  )
  const bytes = Buffer.from('0000ftyp0000video-data')
  const form = new FormData()
  form.set('uploadId', upload)
  form.set('totalChunks', '1')
  form.set('chunkIndex', '0')
  form.set('chunk', new File([bytes], 'clip.mp4'))
  await saveChunk('ALICE', form)
  let path = ''
  s.process.mockImplementation(async (source) => {
    path = source.path
    throw new Error('stage unavailable')
  })
  await expect(
    completeUpload('ALICE', {
      uploadId: upload,
      totalChunks: 1,
      fileName: 'clip.mp4',
      folderName: 'alice',
      eventId: 1,
    }),
  ).rejects.toThrow('stage unavailable')
  const { existsSync } = await import('node:fs')
  expect(existsSync(path)).toBe(false)
  expect((await s.db.query('SELECT count(*)::int n FROM upload_chunks')).rows[0].n).toBe(1)
})

it('App Owner grants all albums and manual sync without a main-admin row; removal loses that access', async () => {
  s.caller = { username: 'ALICE', role: 'admin', appOwner: true }
  expect((await albumCaller()).mainAdmin).toBe(true)
  expect(await accessibleAlbumIds()).toEqual([1, 2, 3])
  expect((await requireAlbumAccess(2, true)).canEdit).toBe(true)
  s.sync.mockResolvedValue({ photos: { synced: 0 }, events: { synced: 0 } })
  expect((await sync(req({}))).status).toBe(200)
  s.caller = { username: 'ALICE', role: 'admin', appOwner: false }
  expect((await albumCaller()).mainAdmin).toBe(false)
  await expect(requireAlbumAccess(2, true)).rejects.toMatchObject({ status: 404 })
  expect((await sync(req({}))).status).toBe(403)
})

it('travel summaries respect ownership, sharing and main-admin access without leaking private locations', async () => {
  const { travelStops } = await import('@/lib/travel/travels')
  await s.db.exec(
    `UPDATE photos SET latitude=10.12,longitude=20.23,date_taken='2025-06-01',city='Test city',country='Test country';`,
  )
  expect((await travelStops('mine')).map((r) => r.eventId)).toEqual([1])
  const visible = await travelStops('accessible')
  expect(visible.map((r) => r.eventId)).toEqual([1, 3])
  expect(visible[0]).toMatchObject({ lat: 10.1, lng: 20.2, year: 2025, count: 1 })
  s.caller.role = 'admin'
  expect((await travelStops('accessible')).map((r) => r.eventId)).toEqual([1, 3])
  await s.db.exec(`INSERT INTO album_shares(event_id,username,created_by) VALUES (2,'ALICE','BOB')`)
  expect((await travelStops('accessible')).map((r) => r.eventId)).toEqual([1, 2, 3])
  await s.db.exec(`DELETE FROM album_shares`)
  s.caller.appOwner = true
  expect((await travelStops('accessible')).map((r) => r.eventId)).toEqual([1, 2, 3])
  expect((await travelStops('mine')).map((r) => r.eventId)).toEqual([1])
})
it('travel summaries keep missing GPS and unknown dates separate from valid zero coordinates', async () => {
  const { travelStops } = await import('@/lib/travel/travels')
  await s.db.exec(
    `UPDATE photos SET latitude=0,longitude=0 WHERE photo_id=1;UPDATE photos SET latitude=100,longitude=20 WHERE photo_id=3;`,
  )
  const rows = await travelStops('accessible')
  expect(rows.find((r) => r.eventId === 1)).toMatchObject({ lat: 0, lng: 0, year: null })
  expect(rows.find((r) => r.eventId === 3)).toMatchObject({ lat: null, lng: null, year: null })
})

it('shared readers cannot mutate global favorites through single or bulk endpoints', async () => {
  const { POST: favorite } = await import('@/app/api/photos/[photoId]/favorite/route')
  await s.db.exec("INSERT INTO album_shares(event_id,username,created_by) VALUES(2,'ALICE','BOB')")
  for (const id of [2, 3]) {
    expect(
      (await favorite(req({}), { params: Promise.resolve({ photoId: String(id) }) })).status,
    ).toBe(403)
    for (const action of ['favorite', 'unfavorite'])
      expect((await bulk(req({ ids: [1, id], action }))).status).toBe(403)
  }
  expect((await s.db.query('SELECT favorite FROM photos ORDER BY photo_id')).rows).toEqual([
    { favorite: true },
    { favorite: true },
    { favorite: true },
  ])
  expect((await favorite(req({}), { params: Promise.resolve({ photoId: '1' }) })).status).toBe(200)
  s.caller = { username: 'OWNER', role: 'admin', appOwner: true }
  expect((await favorite(req({}), { params: Promise.resolve({ photoId: '2' }) })).status).toBe(200)
})

it('direct album and photo endpoints deny private identifiers and readonly writes', async () => {
  const event = await import('@/app/api/events/[eventId]/route')
  const photo = await import('@/app/api/photos/[photoId]/route')
  const url = await import('@/app/api/photos/[photoId]/url/route')
  const labels = await import('@/app/api/photos/[photoId]/labels/route')
  const date = await import('@/app/api/photos/[photoId]/date/route')
  const pc = (id: number) => ({ params: Promise.resolve({ photoId: String(id) }) })
  for (const role of ['viewer', 'admin', 'admin_readonly'] as const) {
    s.caller = { username: 'ALICE', role }
    expect(
      (await event.GET(new Request('https://app/api/events/2?paged=true'), ctx(2))).status,
    ).toBe(404)
    expect((await photo.GET(req({}), pc(2))).status).toBe(404)
    expect((await url.GET(req({}), pc(2))).status).toBe(404)
  }
  s.caller = { username: 'ALICE', role: 'admin_readonly' }
  for (const response of [
    await event.PATCH(req({ eventName: 'Changed' }), ctx(1)),
    await event.DELETE(req({}), ctx(1)),
    await photo.PATCH(req({}), pc(1)),
    await photo.DELETE(req({}), pc(1)),
    await labels.PATCH(req({ title: 'Changed' }), pc(1)),
    await date.PATCH(req({ dateTaken: null }), pc(1)),
    await sharing(req({ action: 'share', username: 'BOB' }), ctx(1)),
  ])
    expect(response.status).toBe(403)
  expect(
    (await s.db.query('SELECT event_name FROM events WHERE event_id=1')).rows[0].event_name,
  ).toBe('Alice private')
  expect((await s.db.query('SELECT count(*)::int n FROM photos')).rows[0].n).toBe(3)
  expect(s.url).not.toHaveBeenCalled()
})

it('limits rapid new uploads even when previous sessions are cancelled', async () => {
  await s.db.query("INSERT INTO upload_start_limits(owner,starts) VALUES('ALICE',60)")
  await expect(chunk('ALICE')).rejects.toMatchObject({ status: 429 })
  await s.db.exec("UPDATE upload_start_limits SET window_start=now()-interval '2 minutes'")
  await expect(chunk('ALICE')).resolves.toBeUndefined()
})

it('queued uploads pass the old 60-start window while retaining receiving concurrency', async () => {
  vi.stubEnv('UPLOAD_PROCESSING_QUEUE_ENABLED', 'true')
  try {
    await s.db.query("INSERT INTO upload_start_limits(owner,starts) VALUES('ALICE',60)")
    for (let i = 1; i <= 4; i++)
      await expect(
        chunk('ALICE', `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`),
      ).resolves.toBeUndefined()
    await expect(chunk('ALICE', '11111111-1111-4111-8111-999999999999')).rejects.toMatchObject({
      status: 429,
    })
    expect(
      (await s.db.query("SELECT starts FROM upload_start_limits WHERE owner='ALICE'")).rows[0]
        .starts,
    ).toBe(60)
  } finally {
    vi.unstubAllEnvs()
  }
})
it('an explicit start budget still throttles queued uploads with a retry deadline', async () => {
  vi.stubEnv('UPLOAD_PROCESSING_QUEUE_ENABLED', 'true')
  vi.stubEnv('UPLOAD_STARTS_PER_USER_PER_MINUTE', '2')
  try {
    await s.db.query("INSERT INTO upload_start_limits(owner,starts) VALUES('ALICE',2)")
    await expect(chunk('ALICE')).rejects.toMatchObject({ status: 429 })
    await s.db.exec("UPDATE upload_start_limits SET window_start=now()-interval '2 minutes'")
    await expect(chunk('ALICE')).resolves.toBeUndefined()
  } finally {
    vi.unstubAllEnvs()
  }
})

import { GET as locationGet, POST as locationPost } from '@/app/api/events/[eventId]/location/route'

it('bulk location fills only missing coordinates, preserves originals, queues search, and supports idempotent apply and undo', async () => {
  await s.db.exec(`UPDATE photos SET city='Old city' WHERE photo_id=1;
 INSERT INTO photos(event_id,source_filename,original_stage_path,ingest_status,latitude,longitude) VALUES
 (1,'gps.jpg','originals/gps.jpg','READY',10,20),(1,'partial.jpg','originals/partial.jpg','READY',5,NULL);
 DELETE FROM search_queue;`)
  const place = {
    label: 'San José, Costa Rica',
    lat: 9.93,
    lng: -84.08,
    city: 'San José',
    region: null,
    country: 'Costa Rica',
  }
  expect((await (await locationGet(req({}), ctx(1))).json()).eligible).toBe(1)
  const applied = await locationPost(req({ action: 'apply', place }), ctx(1))
  expect(applied.status).toBe(200)
  const result = await applied.json()
  expect(result.count).toBe(1)
  const row = (
    await s.db.query(
      'SELECT latitude,longitude,city,original_stage_path,location_assignment_id FROM photos WHERE photo_id=1',
    )
  ).rows[0]
  expect(row).toMatchObject({
    latitude: 9.93,
    longitude: -84.08,
    city: 'San José',
    original_stage_path: 'originals/a.jpg',
    location_assignment_id: result.id,
  })
  expect(
    (await s.db.query("SELECT count(*)::int AS n FROM search_queue WHERE kind='photo' AND id=1"))
      .rows[0].n,
  ).toBe(1)
  expect((await (await locationPost(req({ action: 'apply', place }), ctx(1))).json()).count).toBe(0)
  expect(
    (await (await locationPost(req({ action: 'undo', id: result.id }), ctx(1))).json()).count,
  ).toBe(1)
  expect(
    (
      await s.db.query(
        'SELECT latitude,longitude,city,location_assignment_id FROM photos WHERE photo_id=1',
      )
    ).rows[0],
  ).toMatchObject({
    latitude: null,
    longitude: null,
    city: 'Old city',
    location_assignment_id: null,
  })
  expect(
    (await s.db.query("SELECT latitude,longitude FROM photos WHERE source_filename='gps.jpg'"))
      .rows[0],
  ).toEqual({ latitude: 10, longitude: 20 })
  expect(
    (await s.db.query("SELECT latitude,longitude FROM photos WHERE source_filename='partial.jpg'"))
      .rows[0],
  ).toEqual({ latitude: 5, longitude: null })
})
it('location API rejects non-owners, read-only admins, invalid coordinates and cross-album undo', async () => {
  const place = { label: 'Town', lat: 1, lng: 2 }
  expect((await locationPost(req({ action: 'apply', place }), ctx(2))).status).toBe(404)
  expect((await locationPost(req({ action: 'apply', place }), ctx(3))).status).toBe(403)
  s.caller = { username: 'ALICE', role: 'admin_readonly', canManagePersonal: true }
  expect((await locationPost(req({ action: 'apply', place }), ctx(1))).status).toBe(403)
  s.caller = { username: 'ALICE', role: 'viewer' }
  expect(
    (await locationPost(req({ action: 'apply', place: { ...place, lat: 91 } }), ctx(1))).status,
  ).toBe(400)
  expect((await locationPost(req({ action: 'oops', place }), ctx(1))).status).toBe(400)
  s.caller = { username: 'EXAMPLEADMIN', role: 'admin', appOwner: true }
  const change = await (await locationPost(req({ action: 'apply', place }), ctx(2))).json()
  expect(change.count).toBe(1)
  expect((await locationPost(req({ action: 'undo', id: change.id }), ctx(1))).status).toBe(404)
  expect(
    (await (await locationPost(req({ action: 'undo', id: change.id }), ctx(2))).json()).count,
  ).toBe(1)
})

it('retains authenticated identity through slow video assembly without reauthenticating', async () => {
  await s.db.exec(
    "INSERT INTO folders(folder_name,owner_username) VALUES('Uploads','ALICE'); UPDATE events SET folder_id=1 WHERE event_id=1",
  )
  const { getCallerIdentity } = await import('@/lib/identity/auth')
  const auth = vi.mocked(getCallerIdentity)
  const form = new FormData()
  form.set('uploadId', upload)
  form.set('totalChunks', '1')
  form.set('chunkIndex', '0')
  form.set('chunk', new File(['video'], 'clip.mp4'))
  await saveChunk('ALICE', form)
  auth
    .mockImplementationOnce(async () => s.caller)
    .mockImplementation(async () => {
      throw new Error('Invalid gateway identity')
    })
  try {
    await expect(
      completeUpload('ALICE', {
        uploadId: upload,
        totalChunks: 1,
        fileName: 'clip.mp4',
        folderName: 'alice',
        eventId: 1,
      }),
    ).resolves.toMatchObject({ eventId: 1 })
  } finally {
    auth.mockImplementation(async () => s.caller)
  }
})

it('rejects normalized duplicate folder names per owner on create and rename', async () => {
  const { createFolder, renameFolder } = await import('@/lib/albums/folders')
  const first = await createFolder('  Summer   Trips  ', 0, 'ALICE')
  await expect(createFolder('summer trips', 0, 'ALICE')).rejects.toMatchObject({ status: 409 })
  await expect(createFolder('SUMMER TRIPS', 0, 'BOB')).resolves.toBeTypeOf('number')
  const second = await createFolder('Other', 0, 'ALICE')
  await expect(renameFolder(second, ' SUMMER  trips ')).rejects.toMatchObject({ status: 409 })
  await expect(renameFolder(first, 'Summer Trips')).resolves.toBeUndefined()
  await createFolder('Shared Trips', 0, null)
  await expect(createFolder('shared  trips', 0, null)).rejects.toMatchObject({ status: 409 })
})

it('keeps other users folders manageable by App Owner but out of destination dropdowns', async () => {
  const { createFolder, listFolders } = await import('@/lib/albums/folders')
  const own = await createFolder('Own', 0, 'ALICE')
  const other = await createFolder('Other', 0, 'BOB')
  const shared = await createFolder('Shared', 0, null)
  const folders = await listFolders(null, {
    username: 'ALICE',
    role: 'admin',
    mainAdmin: true,
    appOwner: true,
  })
  expect(folders.find((f) => f.folderId === own)).toMatchObject({ canEdit: true, canSelect: true })
  expect(folders.find((f) => f.folderId === shared)).toMatchObject({
    canEdit: true,
    canSelect: true,
  })
  expect(folders.find((f) => f.folderId === other)).toMatchObject({
    ownerDisplayName: 'Bob',
    canEdit: true,
    canSelect: false,
  })
})

it('persists folder expansion per authenticated user and rejects inaccessible folders', async () => {
  const { PUT } = await import('@/app/api/folders/state/route')
  const { GET } = await import('@/app/api/folders/route')
  await s.db.exec(
    "INSERT INTO folders(folder_name,owner_username) VALUES('Shared',NULL),('Bob only','BOB'); UPDATE events SET folder_id=1 WHERE event_id=3",
  )
  expect((await PUT(req({ folderId: 1, expanded: false, username: 'BOB' }))).status).toBe(200)
  expect(
    (await (await GET(new Request('https://app/api/folders'))).json()).find(
      (f: any) => f.folderId === 1,
    ).expanded,
  ).toBe(false)
  s.caller = { username: 'BOB', role: 'viewer' }
  expect(
    (await (await GET(new Request('https://app/api/folders'))).json()).find(
      (f: any) => f.folderId === 1,
    ).expanded,
  ).toBe(true)
  s.caller = { username: 'ALICE', role: 'viewer' }
  expect((await PUT(req({ folderId: 2, expanded: false }))).status).toBe(404)
  expect((await PUT(req({ folderId: 1, expanded: 'false' }))).status).toBe(400)
  expect((await PUT(req({ folderId: 1, expanded: true }))).status).toBe(200)
  expect(
    (await (await GET(new Request('https://app/api/folders'))).json()).find(
      (f: any) => f.folderId === 1,
    ).expanded,
  ).toBe(true)
  await (await import('@/lib/albums/folders')).deleteFolder(1)
  expect((await s.db.query('SELECT * FROM user_folder_state')).rows).toHaveLength(0)
})

it('travel years prefer capture dates then album year and retain unknown dates', async () => {
  const { travelStops } = await import('@/lib/travel/travels')
  await s.db.exec(
    "UPDATE events SET event_year=2003 WHERE event_id=1; UPDATE photos SET date_taken='2024-06-01T12:00:00Z' WHERE photo_id=1; INSERT INTO photos(event_id,source_filename,original_stage_path,ingest_status) VALUES(1,'undated.jpg','originals/undated.jpg','READY')",
  )
  const rows = await travelStops('accessible')
  expect(
    rows
      .filter((r) => r.eventId === 1)
      .map((r) => r.year)
      .sort(),
  ).toEqual([2003, 2024])
  expect(rows.find((r) => r.eventId === 3)?.year).toBeNull()
  expect(rows.some((r) => r.eventId === 2)).toBe(false)
})

it('public links enforce ownership, expiration, revocation and owner changes', async () => {
  const { createPublicLink, publicAlbum, revokePublicLink } =
    await import('@/lib/albums/public-albums')
  const expiry = new Date(Date.now() + 86400000).toISOString()
  await expect(createPublicLink(2, expiry, false)).rejects.toMatchObject({ status: 404 })
  await expect(createPublicLink(1, '2000-01-01', false)).rejects.toMatchObject({ status: 400 })
  const link = await createPublicLink(1, expiry, false)
  const token = link.path.split('/').pop()!
  expect((await publicAlbum(token)).event_id).toBe(1)
  const stored = (await s.db.query('SELECT * FROM album_public_links')).rows[0]
  expect(stored.token_hash).not.toBe(token)
  expect(JSON.stringify(stored)).not.toContain(token)
  await expect(publicAlbum('a'.repeat(43))).rejects.toMatchObject({ status: 404 })
  await s.db.exec("UPDATE album_public_links SET expires_at=now()-interval '1 second'")
  await expect(publicAlbum(token)).rejects.toMatchObject({ status: 404 })
  await s.db.query('UPDATE album_public_links SET expires_at=$1', [expiry])
  await s.db.exec("UPDATE events SET owner_username='BOB' WHERE event_id=1")
  await expect(publicAlbum(token)).rejects.toMatchObject({ status: 404 })
  await s.db.exec("UPDATE events SET owner_username='ALICE' WHERE event_id=1")
  await revokePublicLink(1, link.id)
  await expect(publicAlbum(token)).rejects.toMatchObject({ status: 404 })
})
it('public media never fetches other albums or forbidden originals and HTML escapes titles', async () => {
  const { createPublicLink, revokePublicLink } = await import('@/lib/albums/public-albums')
  const { GET: media } = await import('@/app/share/[token]/media/[photoId]/route')
  const { GET: gallery } = await import('@/app/share/[token]/route')
  const link = await createPublicLink(1, new Date(Date.now() + 86400000).toISOString(), false)
  const token = link.path.split('/').pop()!
  const call = (id: string, kind: string) =>
    media(new Request('https://photos.example/share/' + token + '/media/' + id + '?kind=' + kind), {
      params: Promise.resolve({ token, photoId: id }),
    })
  expect((await call('2', 'display')).status).toBe(404)
  expect((await call('1', 'original')).status).toBe(403)
  expect(fetch).not.toHaveBeenCalled()
  await s.db.query('UPDATE events SET event_name=$1 WHERE event_id=1', [
    '<script>alert(1)</script>',
  ])
  const page = await gallery(new Request('https://photos.example' + link.path), {
    params: Promise.resolve({ token }),
  })
  expect(page.status).toBe(200)
  expect(page.headers.get('Cache-Control')).toContain('no-store')
  expect(await page.text()).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  s.url.mockResolvedValue('https://storage.example/private-signed-url')
  vi.mocked(fetch).mockResolvedValue(
    new Response('image-bytes', { headers: { 'content-type': 'image/jpeg' } }),
  )
  const preview = await call('1', 'thumbnail')
  expect(preview.status).toBe(200)
  expect(preview.headers.get('location')).toBeNull()
  expect(await preview.text()).toBe('image-bytes')
  vi.mocked(fetch).mockClear()
  await revokePublicLink(1, link.id)
  expect((await call('1', 'thumbnail')).status).toBe(404)
  expect(fetch).not.toHaveBeenCalled()
})
it('shared links list isolates users, permits owner filtering, and never exposes tokens', async () => {
  const { createPublicLink, listSharedLinks, revokePublicLink } =
    await import('@/lib/albums/public-albums')
  const expiry = new Date(Date.now() + 86400000).toISOString()
  const alice = await createPublicLink(1, expiry, false)
  s.caller = { username: 'BOB', role: 'viewer' }
  const bob = await createPublicLink(2, expiry, true)
  s.caller = { username: 'ALICE', role: 'admin' }
  const own = await listSharedLinks('BOB')
  expect(own.links.map((l) => l.id)).toEqual([alice.id])
  expect(own.owners).toEqual([])
  expect(own.canFilterOwners).toBe(false)
  expect(JSON.stringify(own)).not.toContain('token')
  expect(JSON.stringify(own)).not.toContain(alice.path)
  await expect(revokePublicLink(2, bob.id)).rejects.toMatchObject({ status: 404 })
  s.caller = { username: 'EXAMPLEADMIN', role: 'admin' }
  expect((await listSharedLinks()).links).toHaveLength(2)
  expect((await listSharedLinks('BOB')).links.map((l) => l.id)).toEqual([bob.id])
  await revokePublicLink(2, bob.id)
  expect((await listSharedLinks('', 'revoked')).links.map((l) => l.id)).toEqual([bob.id])
  await s.db.query("UPDATE album_public_links SET expires_at=now()-interval '1 hour' WHERE id=$1", [
    alice.id,
  ])
  expect((await listSharedLinks('', 'expired')).links.map((l) => l.id)).toEqual([alice.id])
  s.caller = { username: 'ALICE', role: 'admin_readonly' }
  expect((await listSharedLinks()).links[0].canRevoke).toBe(false)
  await expect(revokePublicLink(1, alice.id)).rejects.toMatchObject({ status: 403 })
})
it('shared links pagination is bounded and ownership changes invalidate links', async () => {
  const { createPublicLink, listSharedLinks } = await import('@/lib/albums/public-albums')
  const link = await createPublicLink(1, new Date(Date.now() + 86400000).toISOString(), false)
  await s.db.exec("UPDATE events SET owner_username='BOB' WHERE event_id=1")
  expect((await listSharedLinks()).links).toHaveLength(0)
  s.caller = { username: 'BOB', role: 'viewer' }
  expect((await listSharedLinks()).links[0]).toMatchObject({ id: link.id, status: 'invalidated' })
  await s.db.exec(
    `INSERT INTO album_public_links(id,event_id,token_hash,owner_username,created_by,expires_at) SELECT gen_random_uuid(),2,'test-'||n,'BOB','BOB',now()+interval '1 day' FROM generate_series(1,51) n`,
  )
  const first = await listSharedLinks()
  const second = await listSharedLinks('', 'all', 1)
  expect(first.links).toHaveLength(50)
  expect(first.hasMore).toBe(true)
  expect(second.links).toHaveLength(2)
  expect(second.hasMore).toBe(false)
  expect(new Set([...first.links, ...second.links].map((l) => l.id)).size).toBe(52)
})
it('gateway shared-media handoff keeps live share, album and download restrictions', async () => {
  const { createPublicLink, revokePublicLink } = await import('@/lib/albums/public-albums')
  const { GET: media } = await import('@/app/share/[token]/media/[photoId]/route')
  const link = await createPublicLink(1, new Date(Date.now() + 86400000).toISOString(), false)
  const token = link.path.split('/').pop()!
  const call = (id = '1', kind = 'thumbnail') =>
    media(
      new Request('https://photos.example/share/' + token + '/media/' + id + '?kind=' + kind, {
        headers: {
          'x-photo-media-transfer': 'public-sql-v2',
          'sf-context-current-user': 'PERSONAL_PHOTOS_GATEWAY',
        },
      }),
      { params: Promise.resolve({ token, photoId: id }) },
    )
  const r = await call()
  expect(r.headers.get('x-photo-media-transfer')).toBe('public-sql-v2')
  expect((await r.json()).path).toBeTruthy()
  expect(fetch).not.toHaveBeenCalled()
  expect((await call('2')).status).toBe(404)
  expect((await call('1', 'original')).status).toBe(403)
  await revokePublicLink(1, link.id)
  expect((await call()).status).toBe(404)
  expect(fetch).not.toHaveBeenCalled()
})

it('protects HLS playlists and segment files with current album access', async () => {
  vi.stubEnv('VIDEO_STREAMING_ENABLED', 'true')
  const { GET: playlist } = await import('@/app/api/videos/[photoId]/playlist/route')
  const context = { params: Promise.resolve({ photoId: '1' }) }
  const manifest =
    '#EXTM3U\n#EXT-X-MAP:URI="playback.mp4",BYTERANGE="1476@0"\n#EXTINF:6,\n#EXT-X-BYTERANGE:500@1476\nplayback.mp4\n#EXT-X-ENDLIST\n'
  await s.db.query(
    "INSERT INTO video_playback(photo_id,original_path,status,stage_path,playlist,format_version,renditions) VALUES(1,'originals/a.jpg','ready','display/video/test/playback.mp4',$1,2,$2)",
    [
      manifest,
      JSON.stringify([
        {
          name: '720',
          stage_path: 'display/video/test/playback.mp4',
          playlist: manifest,
          bandwidth: 3756000,
          averageBandwidth: 3000000,
          width: 1280,
          height: 720,
          frameRate: 30,
          codecs: 'avc1.64001f,mp4a.40.2',
        },
      ]),
    ],
  )
  const master = await playlist(new Request('https://app/api/videos/1/playlist'), context)
  expect(master.status).toBe(200)
  expect(await master.text()).toContain('/api/videos/1/playlist?variant=720')
  const variant = await playlist(
    new Request('https://app/api/videos/1/playlist?variant=720'),
    context,
  )
  expect(variant.status).toBe(200)
  expect(await variant.text()).toContain('/api/images?')
  expect(
    (await playlist(new Request('https://app/api/videos/1/playlist?variant=evil'), context)).status,
  ).toBe(404)
  const { createPublicLink, revokePublicLink } = await import('@/lib/albums/public-albums')
  const { GET: sharedMedia } = await import('@/app/share/[token]/media/[photoId]/route')
  const link = await createPublicLink(1, new Date(Date.now() + 3600000).toISOString(), false)
  const token = link.path.split('/').pop()!
  const shared = (kind: string) =>
    sharedMedia(
      new Request('https://app' + link.path + '/media/1?' + kind, {
        headers: {
          'x-photo-media-transfer': 'public-sql-v2',
          'sf-context-current-user': 'PERSONAL_PHOTOS_GATEWAY',
        },
      }),
      { params: Promise.resolve({ token, photoId: '1' }) },
    )
  expect((await shared('kind=playlist')).status).toBe(200)
  expect((await shared('kind=playlist&variant=720')).status).toBe(200)
  expect((await (await shared('kind=segment&variant=720')).json()).path).toBe(
    'display/video/test/playback.mp4',
  )
  expect((await shared('kind=segment&variant=evil')).status).toBe(404)
  await revokePublicLink(1, link.id)
  expect((await shared('kind=segment&variant=720')).status).toBe(404)
  s.caller = { username: 'BOB', role: 'viewer' }
  expect((await playlist(new Request('https://app/api/videos/1/playlist'), context)).status).toBe(
    404,
  )
  expect(
    (await media(new Request('https://app/api/images?path=display%2Fvideo%2Ftest%2Fplayback.mp4')))
      .status,
  ).toBe(404)
  expect(s.url).not.toHaveBeenCalled()
})

it('prepares uploads outside a transaction and rejects ownership changes before publication', async () => {
  await s.db.exec(
    "INSERT INTO folders(folder_name,owner_username) VALUES('Uploads','ALICE'); UPDATE events SET folder_id=1 WHERE event_id=1",
  )
  const { ingestUpload } = await import('@/lib/upload/ingest-upload')
  s.prepare.mockImplementationOnce(async () => {
    expect(s.tx).toBeNull()
    await s.db.exec("UPDATE events SET owner_username='BOB' WHERE event_id=1")
  })
  await expect(
    ingestUpload(Buffer.from('image'), { fileName: 'new.jpg', folderName: 'alice', eventId: 1 }),
  ).rejects.toMatchObject({ status: 404 })
  expect(s.process).not.toHaveBeenCalled()
  expect((await s.db.query('SELECT count(*)::int n FROM upload_jobs')).rows[0].n).toBe(0)
})
it('paginates tied album sort keys without leaking private albums and preserves full counts', async () => {
  const { albumPage } = await import('@/lib/albums/album-page')
  await s.db.exec(
    `INSERT INTO events(sort_order,event_name,source_folder,owner_username,visibility) SELECT 1,'page '||i,'page/'||i,'ALICE','PRIVATE' FROM generate_series(1,110) i`,
  )
  const caller = await albumCaller()
  const first = await albumPage(caller, new URLSearchParams('scope=mine'))
  expect(first.items).toHaveLength(96)
  expect(first.groups?.reduce((n, g) => n + g.albums, 0)).toBe(111)
  const second = await albumPage(
    caller,
    new URLSearchParams({ scope: 'mine', cursor: first.nextCursor! }),
  )
  const ids = [...first.items, ...second.items].map((e) => e.eventId)
  expect(ids).toHaveLength(111)
  expect(new Set(ids).size).toBe(111)
  expect(ids).not.toContain(2)
  expect(ids).not.toContain(3)
  expect(second.nextCursor).toBeNull()
  await expect(albumPage(caller, new URLSearchParams('cursor=bad'))).rejects.toMatchObject({
    status: 400,
  })
})
it('returns empty page and counts together for a caller with no visible albums', async () => {
  const { albumPage } = await import('@/lib/albums/album-page')
  const caller = { ...(await albumCaller()), username: 'NO_ALBUMS', mainAdmin: false }
  const page = await albumPage(caller, new URLSearchParams('scope=mine'))
  expect(page).toEqual({ items: [], nextCursor: null, groups: [] })
})
it('aggregates viewport GPS on the server with ACLs, year fallback and identical-position grouping', async () => {
  const { viewportClusters, travelStops } = await import('@/lib/travel/travels')
  await s.db.exec(
    `UPDATE photos SET latitude=40.001,longitude=-74.002;UPDATE events SET event_year=2003;INSERT INTO photos(event_id,source_filename,original_stage_path,latitude,longitude) VALUES(1,'d.jpg','originals/d.jpg',40.001,-74.002)`,
  )
  const p = new URLSearchParams('south=39&north=41&west=-75&east=-73&zoom=14&year=2003')
  const mine = await viewportClusters('mine', p)
  expect(mine).toHaveLength(1)
  expect(mine[0]).toMatchObject({
    count: 2,
    points: 1,
    lat: 40.001,
    lng: -74.002,
    areaId: '40,-74',
  })
  expect((await viewportClusters('accessible', p)).reduce((n, c) => n + c.count, 0)).toBe(3)
  p.set('zoom', '19')
  expect((await viewportClusters('mine', p)).reduce((n, c) => n + c.count, 0)).toBe(2)
  expect((await viewportClusters('accessible', p)).reduce((n, c) => n + c.count, 0)).toBe(3)
  p.set('year', '2004')
  expect(await viewportClusters('mine', p)).toEqual([])
  const stops = await travelStops('mine')
  expect(stops.reduce((n, r) => n + r.count, 0)).toBe(2)
  p.set('zoom', '99')
  await expect(viewportClusters('mine', p)).rejects.toMatchObject({ status: 400 })
})

it('media and album read permissions agree for owners, shares, gallery and every admin role', async () => {
  const { lookupMedia } = await import('@/lib/media/media-lookup')
  await s.db.exec(`UPDATE photos SET display_stage_path='display/'||photo_id||'.jpg';
    INSERT INTO album_shares(event_id,username,created_by) VALUES(2,'SHARED','BOB');
    INSERT INTO video_playback(photo_id,original_path,status,stage_path,renditions)
    SELECT photo_id,original_stage_path,'ready','display/video/'||photo_id||'.mp4',
    jsonb_build_array(jsonb_build_object('stage_path','display/video/'||photo_id||'/720.mp4')) FROM photos;`)
  for (const caller of [
    { username: 'ALICE', role: 'viewer' as const },
    { username: 'BOB', role: 'viewer' as const },
    { username: 'SHARED', role: 'viewer' as const },
    { username: 'STRANGER', role: 'viewer' as const },
    { username: 'STRANGER', role: 'admin' as const },
    { username: 'ALICE', role: 'admin_readonly' as const },
    { username: 'EXAMPLEADMIN', role: 'admin' as const },
    { username: 'EXAMPLEADMIN', role: 'admin_readonly' as const },
    { username: 'OWNER', role: 'admin' as const, appOwner: true },
    { username: 'OWNER', role: 'admin_readonly' as const, appOwner: true },
  ]) {
    s.caller = caller
    for (const id of [1, 2, 3]) {
      const allowed = await requireAlbumAccess(id).then(
        () => true,
        () => false,
      )
      const letter = String.fromCharCode(96 + id)
      for (const path of [
        `originals/${letter}.jpg`,
        `thumbnails/${letter}.jpg`,
        `display/${id}.jpg`,
        `display/video/${id}.mp4`,
        `display/video/${id}/720.mp4`,
      ])
        expect(!!(await lookupMedia(path)), `${caller.username}/${caller.role}/${path}`).toBe(
          allowed,
        )
    }
  }
  s.caller = { username: 'SHARED', role: 'viewer' }
  await s.db.exec("DELETE FROM album_shares WHERE username='SHARED'")
  await expect(requireAlbumAccess(2)).rejects.toMatchObject({ status: 404 })
  expect(await lookupMedia('thumbnails/b.jpg')).toBeNull()
})

it('checks access before choosing among duplicate media paths', async () => {
  const { lookupMedia } = await import('@/lib/media/media-lookup')
  // The inaccessible original branch comes before the accessible thumbnail branch.
  await s.db.exec(
    "UPDATE photos SET original_stage_path='thumbnails/collision.jpg' WHERE photo_id=2; UPDATE photos SET thumbnail_stage_path='thumbnails/collision.jpg' WHERE photo_id=1",
  )
  expect((await lookupMedia('thumbnails/collision.jpg'))?.photo_id).toBe(1)
})

it('photo details supply only authorized still-image preload neighbors and reject revoked access', async () => {
  const { GET } = await import('@/app/api/photos/[photoId]/route')
  await s.db
    .exec(`UPDATE photos SET display_stage_path='display/'||photo_id||'.jpg',date_taken='2026-01-01';
    INSERT INTO photos(event_id,source_filename,media_type,ingest_status,display_stage_path,date_taken) VALUES
    (1,'next.jpg','photo','READY','display/next.jpg','2026-01-02'),
    (1,'video.mov','video','READY','display/video.mp4','2026-01-03');`)
  const read = (id: number) =>
    GET(new Request('https://app/api/photos/' + id), {
      params: Promise.resolve({ photoId: String(id) }),
    })
  await s.db.exec('UPDATE events SET cover_photo_id=1 WHERE event_id=1')
  const transactions = vi.spyOn(s.db, 'transaction')
  const response = await read(1)
  expect(response.status).toBe(200)
  // The album viewer is one reader statement; only the favorites viewer opens a transaction.
  expect(transactions).not.toHaveBeenCalled()
  const fromFavorites = await GET(new Request('https://app/api/photos/1?context=favorites'), {
    params: Promise.resolve({ photoId: '1' }),
  })
  expect(fromFavorites.status).toBe(200)
  expect(transactions).toHaveBeenCalledTimes(1)
  transactions.mockRestore()
  const detail = await response.json()
  expect(detail.isAlbumCover).toBe(true)
  await s.db.exec('UPDATE events SET cover_photo_id=NULL WHERE event_id=1')
  expect((await (await read(1)).json()).isAlbumCover).toBe(false)
  expect(detail.preload).toHaveLength(1)
  expect(detail.preload[0].url).toContain('display%2Fnext.jpg')
  expect(detail.preload[0]).not.toHaveProperty('aiDescription')
  s.caller = { username: 'BOB', role: 'viewer' }
  expect((await read(1)).status).toBe(404)
})

it('loads only the requested folder and section while retaining album ACLs', async () => {
  const { albumPage } = await import('@/lib/albums/album-page')
  await s.db.exec(
    "INSERT INTO folders(folder_name,owner_username) VALUES('One','ALICE'),('Two','ALICE'); UPDATE events SET folder_id=1 WHERE event_id IN (1,2); INSERT INTO events(sort_order,event_name,source_folder,owner_username,visibility,folder_id) SELECT 1,'folder '||i,'folder/'||i,'ALICE','PRIVATE',CASE WHEN i%2=0 THEN 1 ELSE 2 END FROM generate_series(1,210) i",
  )
  const caller = await albumCaller()
  const first = await albumPage(caller, new URLSearchParams('scope=mine&section=mine&folder=1'))
  const second = await albumPage(
    caller,
    new URLSearchParams({ scope: 'mine', section: 'mine', folder: '1', cursor: first.nextCursor! }),
  )
  const items = [...first.items, ...second.items]
  expect(items).toHaveLength(106)
  expect(items.every((e) => e.folderId === 1)).toBe(true)
  expect(items.some((e) => e.eventId === 2)).toBe(false)
  expect(new Set(items.map((e) => e.eventId)).size).toBe(106)
  expect((await albumPage(caller, new URLSearchParams('scope=mine&folder=none'))).items).toEqual([])
  expect(
    (await albumPage(caller, new URLSearchParams('scope=mine&section=collection&folder=1'))).items,
  ).toEqual([])
  await expect(albumPage(caller, new URLSearchParams('folder=oops'))).rejects.toMatchObject({
    status: 400,
  })
})

it('stores per-link location and names choices independently and defaults both off', async () => {
  const { createPublicLink, publicAlbum, listPublicLinks } =
    await import('@/lib/albums/public-albums')
  const expiry = new Date(Date.now() + 86400000).toISOString()
  const plain = await createPublicLink(1, expiry, false)
  expect(await publicAlbum(plain.path.split('/').pop()!)).toMatchObject({
    include_location: false,
    include_people: false,
  })
  const named = await createPublicLink(1, expiry, false, false, true)
  expect(await publicAlbum(named.path.split('/').pop()!)).toMatchObject({
    include_location: false,
    include_people: true,
  })
  const located = await createPublicLink(1, expiry, false, true, false)
  expect(await publicAlbum(located.path.split('/').pop()!)).toMatchObject({
    include_location: true,
    include_people: false,
  })
  expect(await listPublicLinks(1)).toHaveLength(3)
  const { GET } = await import('@/app/share/[token]/route')
  const token = plain.path.split('/').pop()!
  const response = await GET(
    new Request('https://example.com/share/' + token + '?asset=tile&photo=1&z=1&x=0&y=0'),
    { params: Promise.resolve({ token }) },
  )
  expect(response.status).toBe(403)
})

it('creates fixed selections only from photos in the editable album', async () => {
  const { createPublicLink, publicAlbum, listPublicLinks } =
    await import('@/lib/albums/public-albums')
  const expiry = new Date(Date.now() + 86400000).toISOString()
  for (const ids of [[], [1, 2], [999], Array(201).fill(1), [0]]) {
    await expect(createPublicLink(1, expiry, false, false, false, ids)).rejects.toMatchObject({
      status: expect.any(Number),
    })
  }
  expect((await s.db.query('SELECT * FROM album_public_links')).rows).toHaveLength(0)
  const selected = await createPublicLink(1, expiry, true, true, true, [1, 1])
  expect((await publicAlbum(selected.path.split('/').pop()!)).photo_ids).toEqual([1])
  await createPublicLink(1, expiry, false)
  const links = await listPublicLinks(1)
  expect(links.map((l: any) => l.selected_count).sort()).toEqual([1, null].sort())
})

it('a selected-photo link exposes only its selection through every public route', async () => {
  // Row security is absent in this suite, so this exercises the application check alone.
  const { createPublicLink } = await import('@/lib/albums/public-albums')
  const { GET: media } = await import('@/app/share/[token]/media/[photoId]/route')
  const { GET: gallery } = await import('@/app/share/[token]/route')
  const { GET: zip } = await import('@/app/share/[token]/download/route')
  await s.db.exec(
    "INSERT INTO photos(event_id,source_filename,original_stage_path,thumbnail_stage_path,ingest_status,latitude,longitude) VALUES(1,'unselected.jpg','originals/unselected.jpg','thumbnails/unselected.jpg','READY',1,1)",
  )
  const hidden = (
    await s.db.query("SELECT photo_id FROM photos WHERE source_filename='unselected.jpg'")
  ).rows[0].photo_id
  const expiry = new Date(Date.now() + 86400000).toISOString()
  const link = await createPublicLink(1, expiry, true, true, false, [1])
  const token = link.path.split('/').pop()!
  const page = (query: string) =>
    gallery(new Request('https://photos.example' + link.path + query), {
      params: Promise.resolve({ token }),
    })
  const file = (id: number, kind: string) =>
    media(new Request(`https://photos.example/share/${token}/media/${id}?kind=${kind}`), {
      params: Promise.resolve({ token, photoId: String(id) }),
    })
  s.url.mockResolvedValue('https://storage.example/signed')
  vi.mocked(fetch).mockImplementation(async () => new Response('bytes'))
  for (const kind of ['thumbnail', 'display', 'original'])
    expect((await file(hidden, kind)).status).toBe(404)
  expect(fetch).not.toHaveBeenCalled()
  expect(s.url).not.toHaveBeenCalled()
  expect((await page(`?photo=${hidden}`)).status).toBe(404)
  expect((await page(`?asset=tile&photo=${hidden}&z=1&x=0&y=0`)).status).toBe(404)
  expect((await (await page('?format=json')).json()).items.map((p: any) => p.photo_id)).toEqual([1])
  expect(await (await page('')).text()).not.toContain('unselected.jpg')
  const archive = await zip(new Request(`https://photos.example/share/${token}/download`), {
    params: Promise.resolve({ token }),
  })
  expect(archive.status).toBe(200)
  await archive.arrayBuffer()
  expect(s.url.mock.calls.map((call: unknown[]) => call[0])).toEqual(['originals/a.jpg'])
  // The selected photo and a whole-album link remain fully available.
  expect((await file(1, 'thumbnail')).status).toBe(200)
  expect((await page('?photo=1')).status).toBe(200)
  const whole = await createPublicLink(1, expiry, false)
  const wholeToken = whole.path.split('/').pop()!
  expect(
    (
      await media(
        new Request(`https://photos.example/share/${wholeToken}/media/${hidden}?kind=thumbnail`),
        { params: Promise.resolve({ token: wholeToken, photoId: String(hidden) }) },
      )
    ).status,
  ).toBe(200)
})

it('reclaims a lost upload lease and fences the previous instance before publishing', async () => {
  const {
    claimUploadCompletion,
    renewUploadCompletion,
    publishUploadCompletion,
    releaseUploadCompletion,
  } = await import('@/lib/upload/upload-completion-claim')
  await chunk('ALICE')
  const first = await claimUploadCompletion(upload, 'ALICE')
  await expect(claimUploadCompletion(upload, 'ALICE')).rejects.toMatchObject({ status: 429 })
  await s.db.query(
    "UPDATE upload_sessions SET completion_lease_until=now()-interval '1 second' WHERE upload_id=$1",
    [upload],
  )
  const second = await claimUploadCompletion(upload, 'ALICE')
  expect(second.token).not.toBe(first.token)
  expect(await renewUploadCompletion(upload, first.token!)).toBe(false)
  const stalePublish = vi.fn()
  await expect(
    publishUploadCompletion(upload, 'ALICE', first.token!, stalePublish),
  ).rejects.toMatchObject({ status: 409 })
  expect(stalePublish).not.toHaveBeenCalled()
  await releaseUploadCompletion(upload, first.token!)
  expect(await renewUploadCompletion(upload, second.token!)).toBe(true)
  const result = { eventId: 1, successCount: 1 }
  await publishUploadCompletion(upload, 'ALICE', second.token!, async () => result)
  expect(await claimUploadCompletion(upload, 'ALICE')).toEqual({ result, token: null })
})

it('canceling an upload fences in-flight completion publication', async () => {
  const { claimUploadCompletion, publishUploadCompletion } =
    await import('@/lib/upload/upload-completion-claim')
  await chunk('ALICE')
  const claim = await claimUploadCompletion(upload, 'ALICE')
  await s.db.query('DELETE FROM upload_sessions WHERE upload_id=$1', [upload])
  const publish = vi.fn()
  await expect(
    publishUploadCompletion(upload, 'ALICE', claim.token!, publish),
  ).rejects.toMatchObject({ status: 409 })
  expect(publish).not.toHaveBeenCalled()
})

it('serves paginated albums without nesting the dedicated read identity transaction', async () => {
  const response = await albums(new Request('https://app/api/events?paged=true&scope=mine'))
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.items.map((e: { eventId: number }) => e.eventId)).toEqual([1])
  expect(body.groups.reduce((n: number, g: { albums: number }) => n + g.albums, 0)).toBe(1)
})
it('keeps album covers within the selected album even when another cover is readable', async () => {
  await s.db.exec(
    "UPDATE events SET visibility='GALLERY' WHERE event_id=2; UPDATE events SET cover_photo_id=(SELECT min(photo_id) FROM photos WHERE event_id=2) WHERE event_id=1",
  )
  const response = await albums(new Request('https://app/api/events?paged=true&scope=mine'))
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.items).toHaveLength(1)
  expect(body.items[0].coverUrl).toBeNull()
})

it('indexed photo neighbors match full ordering for ties, missing dates, boundaries and other albums', async () => {
  await s.db.exec(`INSERT INTO photos(event_id,source_filename,ingest_status,date_taken,created_at)
    SELECT CASE WHEN n%7=0 THEN 2 ELSE 1 END,'neighbor-'||n||'.jpg',
      CASE WHEN n%9=0 THEN 'FAILED' ELSE 'READY' END,
      CASE WHEN n%3=0 THEN NULL ELSE '2026-01-01'::timestamptz+(n%5)*interval '1 day' END,
      '2026-01-01'::timestamptz+(n%5)*interval '1 day'
    FROM generate_series(1,45) n`)
  // The viewer reads through the production page query; a main administrator can read every album.
  const viewer = { username: 'ALICE', role: 'viewer' as const, mainAdmin: true }
  for (const album of [1, 2]) {
    const ordered = (
      await s.db.query(
        `SELECT photo_id FROM photos WHERE event_id=$1 AND ingest_status='READY'
    ORDER BY COALESCE(date_taken,created_at),photo_id`,
        [album],
      )
    ).rows.map((r: any) => r.photo_id)
    expect(ordered.length).toBeGreaterThan(2)
    for (let i = 0; i < ordered.length; i++) {
      const context = await getPhotoViewerPage(ordered[i], viewer)
      expect(context?.adjacent).toEqual({
        prev: ordered[i - 1] ?? null,
        next: ordered[i + 1] ?? null,
        next2: ordered[i + 2] ?? null,
      })
      expect(
        context!.candidates.every((p) =>
          [context!.adjacent.prev, context!.adjacent.next, context!.adjacent.next2].includes(
            p.photo_id,
          ),
        ),
      ).toBe(true)
    }
  }
  expect(await getPhotoViewerPage(999999, viewer)).toBeNull()
})

it('a new queue claim replaces an abandoned completion lease and fences the old worker', async () => {
  const {
    claimUploadCompletion,
    renewUploadCompletion,
    releaseUploadCompletion,
    publishUploadCompletion,
  } = await import('@/lib/upload/upload-completion-claim')
  await chunk('ALICE')
  await s.db.exec(
    "CREATE OR REPLACE FUNCTION photo_security.authorization_epoch() RETURNS text LANGUAGE sql AS $$ SELECT '1'::text $$",
  )
  const first = '11111111-1111-4111-8111-111111111111'
  const second = '22222222-2222-4222-8222-222222222222'
  await s.db.query(
    `INSERT INTO upload_processing_jobs(upload_id,owner,body,caller,auth_epoch,state,lease_token,lease_until)
    VALUES ($1,'ALICE','{}','{}','1','processing',$2,now()+interval '5 minutes')`,
    [upload, first],
  )
  expect((await claimUploadCompletion(upload, 'ALICE', first)).token).toBe(first)
  await expect(claimUploadCompletion(upload, 'ALICE', first)).rejects.toMatchObject({ status: 429 })
  await s.db.query('UPDATE upload_processing_jobs SET lease_token=$2 WHERE upload_id=$1', [
    upload,
    second,
  ])
  expect((await claimUploadCompletion(upload, 'ALICE', second)).token).toBe(second)
  expect(await renewUploadCompletion(upload, first)).toBe(false)
  await releaseUploadCompletion(upload, first)
  expect(await renewUploadCompletion(upload, second)).toBe(true)
  const publish = vi.fn()
  await expect(
    publishUploadCompletion(upload, 'ALICE', first, publish, first),
  ).rejects.toMatchObject({ status: 409 })
  expect(publish).not.toHaveBeenCalled()
  await s.db.query(
    "UPDATE upload_processing_jobs SET lease_until=now()-interval '1 second' WHERE upload_id=$1",
    [upload],
  )
  await expect(claimUploadCompletion(upload, 'ALICE', second)).rejects.toMatchObject({
    status: 409,
  })
})

it('combined paginated photo reads preserve empty albums, sharing, revocation and gallery access', async () => {
  const { GET } = await import('@/app/api/events/[eventId]/route')
  const read = (id: number) =>
    GET(new Request(`https://app/api/events/${id}?paged=true`), {
      params: Promise.resolve({ eventId: String(id) }),
    })
  expect((await read(1)).status).toBe(200)
  expect((await read(2)).status).toBe(404)
  const empty = (
    await s.db.query(
      "INSERT INTO events(sort_order,event_name,source_folder,owner_username,visibility) VALUES(1,'empty','empty','ALICE','PRIVATE') RETURNING event_id",
    )
  ).rows[0].event_id
  const response = await read(empty)
  expect(response.status).toBe(200)
  expect((await response.json()).items).toEqual([])
  await s.db.exec("INSERT INTO album_shares(event_id,username,created_by) VALUES(2,'ALICE','BOB')")
  expect((await read(2)).status).toBe(200)
  await s.db.exec("DELETE FROM album_shares WHERE event_id=2 AND username='ALICE'")
  expect((await read(2)).status).toBe(404)
  await s.db.exec("UPDATE events SET visibility='GALLERY' WHERE event_id=2")
  expect((await read(2)).status).toBe(200)
  expect((await read(999999)).status).toBe(404)
})

it('combined photo details preserve owner edit rights, read-only roles and share revocation', async () => {
  const { GET } = await import('@/app/api/photos/[photoId]/route')
  const read = () =>
    GET(new Request('https://app/api/photos/1'), { params: Promise.resolve({ photoId: '1' }) })
  expect((await (await read()).json()).canEdit).toBe(true)
  s.caller = { username: 'ALICE', role: 'admin_readonly' }
  expect((await (await read()).json()).canEdit).toBe(false)
  s.caller = { username: 'BOB', role: 'viewer' }
  expect((await read()).status).toBe(404)
  await s.db.exec("INSERT INTO album_shares(event_id,username,created_by) VALUES(1,'BOB','ALICE')")
  const shared = await read()
  expect(shared.status).toBe(200)
  const detail = await shared.json()
  expect(detail.canEdit).toBe(false)
  expect(detail).not.toHaveProperty('album_owner')
  await s.db.exec("DELETE FROM album_shares WHERE event_id=1 AND username='BOB'")
  expect((await read()).status).toBe(404)
})

it('pages favorites with stable ties and live album revocation on later pages', async () => {
  const { favoritePhotoPage } = await import('@/lib/photos/photo-page')
  await s.db.exec(`UPDATE photos SET favorite=false;
    INSERT INTO photos(event_id,source_filename,ingest_status,favorite,date_taken)
      SELECT 1,'same.jpg','READY',true,'2026-01-01' FROM generate_series(1,110);
    INSERT INTO photos(event_id,source_filename,ingest_status,favorite,date_taken)
      SELECT 2,'same.jpg','READY',true,'2026-01-01' FROM generate_series(1,110);`)
  const caller = await albumCaller()
  for (const sort of ['oldest', 'newest', 'name', 'uploaded']) {
    const params = new URLSearchParams({ sort, paged: 'true' })
    const first = await favoritePhotoPage(params, caller)
    expect(first.items).toHaveLength(96)
    expect(first.items.every((p) => p.eventId === 1)).toBe(true)
    expect(first.items[0].eventName).toBe('Alice private')
    params.set('cursor', first.nextCursor!)
    const second = await favoritePhotoPage(params, caller)
    expect(second.items).toHaveLength(14)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map((p) => p.photoId)).size).toBe(110)
    params.set('media', 'video')
    await expect(favoritePhotoPage(params, caller)).rejects.toMatchObject({ status: 400 })
  }
  await s.db.exec("INSERT INTO album_shares(event_id,username,created_by) VALUES(2,'ALICE','BOB')")
  const first = await favoritePhotoPage(new URLSearchParams(), caller)
  await s.db.exec('UPDATE photos SET favorite=false WHERE photo_id=' + first.items[0].photoId)
  await s.db.exec('DELETE FROM album_shares WHERE event_id=2')
  const second = await favoritePhotoPage(new URLSearchParams({ cursor: first.nextCursor! }), caller)
  expect(second.items).toHaveLength(14)
  expect(second.items.every((p) => p.eventId === 1)).toBe(true)
  expect(first.items.some((p) => second.items.some((q) => q.photoId === p.photoId))).toBe(false)
})

it('album viewer matches the favorites viewer metadata and respects live revocation', async () => {
  const { GET } = await import('@/app/api/photos/[photoId]/route')
  const read = (query = '') =>
    GET(new Request('https://app/api/photos/1' + query), {
      params: Promise.resolve({ photoId: '1' }),
    })
  // Navigation differs by context; every other field must be identical.
  const metadata = async (response: Response) => {
    const body = await response.json()
    for (const key of ['prev', 'next', 'preload']) delete body[key]
    return body
  }
  const viewer = await read()
  expect(viewer.status).toBe(200)
  expect(await metadata(viewer)).toEqual(await metadata(await read('?context=favorites')))
  s.caller = { username: 'BOB', role: 'viewer' }
  expect((await read()).status).toBe(404)
  await s.db.exec("INSERT INTO album_shares(event_id,username,created_by) VALUES(1,'BOB','ALICE')")
  expect((await read()).status).toBe(200)
  await s.db.exec('DELETE FROM album_shares WHERE event_id=1')
  expect((await read()).status).toBe(404)
})
it('bounded upload review excludes other albums and requires current access', async () => {
  const { GET } = await import('@/app/api/events/[eventId]/review/route')
  const read = (id: number, ids: string) =>
    GET(new Request(`https://app/api/events/${id}/review?ids=${ids}`), ctx(id))
  const r = await read(1, '1,2,99999')
  expect(r.status).toBe(200)
  const rows = await r.json()
  expect(rows.map((p: any) => p.photoId)).toEqual([1])
  expect(Object.keys(rows[0]).sort()).toEqual([
    'dateTaken',
    'latitude',
    'longitude',
    'photoId',
    'sourceFilename',
  ])
  expect((await read(2, '2')).status).toBe(404)
  expect((await read(1, Array.from({ length: 201 }, (_, i) => i + 1).join(','))).status).toBe(400)
})
it('list endpoints reject unpaged reads and retain paged access', async () => {
  const event = await import('@/app/api/events/[eventId]/route')
  expect((await albums(new Request('https://app/api/events'))).status).toBe(400)
  expect((await albums(new Request('https://app/api/events?paged=true'))).status).toBe(200)
  expect((await favorites(new Request('https://app/api/favorites'))).status).toBe(400)
  expect((await favorites(new Request('https://app/api/favorites?paged=true'))).status).toBe(200)
  expect((await event.GET(new Request('https://app/api/events/1'), ctx(1))).status).toBe(400)
  expect((await event.GET(new Request('https://app/api/events/1?paged=true'), ctx(1))).status).toBe(
    200,
  )
})

it('preserves immutable public account identifiers when sharing and revoking albums', async () => {
  const username = 'U_00000000000000000000000000000001'
  await s.db.query(
    "INSERT INTO gallery_access_objects(kind,name,marker,state,created_by,display_name) VALUES('user',$1,gen_random_uuid(),'ready','test','Customer test')",
    [username],
  )
  expect((await sharing(req({ action: 'share', username }), ctx(1))).status).toBe(200)
  expect(
    (
      await s.db.query('SELECT username FROM album_shares WHERE event_id=1 AND username=$1', [
        username,
      ])
    ).rows,
  ).toHaveLength(1)
  expect((await sharing(req({ action: 'revoke', username }), ctx(1))).status).toBe(200)
  expect(
    (
      await s.db.query('SELECT username FROM album_shares WHERE event_id=1 AND username=$1', [
        username,
      ])
    ).rows,
  ).toHaveLength(0)
})

it('Favorites exposes live write capabilities per photo without leaking album ownership', async () => {
  const GET = favorites
  await s.db.exec("INSERT INTO album_shares(event_id,username,created_by) VALUES(2,'ALICE','BOB')")
  for (const [caller, expected] of [
    [
      { username: 'ALICE', role: 'viewer' },
      [
        [1, true],
        [2, false],
        [3, false],
      ],
    ],
    [
      { username: 'ALICE', role: 'admin' },
      [
        [1, true],
        [2, false],
        [3, false],
      ],
    ],
    [{ username: 'STRANGER', role: 'viewer' }, [[3, false]]],
    [
      { username: 'OWNER', role: 'admin', appOwner: true },
      [
        [1, true],
        [2, true],
        [3, true],
      ],
    ],
    [
      { username: 'ALICE', role: 'admin_readonly' },
      [
        [1, false],
        [2, false],
        [3, false],
      ],
    ],
    [
      { username: 'ALICE', role: 'viewer', canManagePersonal: false },
      [
        [1, false],
        [2, false],
        [3, false],
      ],
    ],
  ] as const) {
    s.caller = { ...caller }
    const response = await GET(new Request('https://app/api/favorites?paged=true'))
    expect(response.status).toBe(200)
    const { items } = await response.json()
    expect(items.map((p: { photoId: number; canEdit: boolean }) => [p.photoId, p.canEdit])).toEqual(
      expected,
    )
    expect(items.some((p: object) => 'album_owner' in p || 'owner_username' in p)).toBe(false)
  }
  s.caller = { username: 'ALICE', role: 'viewer' }
  expect((await bulk(req({ ids: [1, 2], action: 'unfavorite' }))).status).toBe(403)
  expect((await s.db.query('SELECT favorite FROM photos WHERE photo_id=1')).rows[0].favorite).toBe(
    true,
  )
  expect((await bulk(req({ ids: [1], action: 'unfavorite' }))).status).toBe(200)
  await s.db.exec(
    "DELETE FROM album_shares WHERE event_id=2; UPDATE events SET owner_username='BOB' WHERE event_id=1",
  )
  const body = await (await GET(new Request('https://app/api/favorites?paged=true'))).json()
  expect(body.items.map((p: { photoId: number }) => p.photoId)).toEqual([3])
  expect((await bulk(req({ ids: [1], action: 'favorite' }))).status).toBe(404)
})
