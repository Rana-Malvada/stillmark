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
import { PGlite } from '@electric-sql/pglite'

const state = vi.hoisted(() => ({
  db: null as any,
  tx: null as any,
  ingest: vi.fn(),
  sf: vi.fn(),
  long: vi.fn(),
  stage: vi.fn(),
  heif: vi.fn(),
}))
vi.mock('@/lib/upload/heif-decode', () => ({ decodeHeif: state.heif }))
vi.mock('@/lib/postgres', () => ({
  pgIndependent: async (sql: string, params?: unknown[]) =>
    (await state.db.query(sql, params)).rows,
  pgQuery: async (sql: string, params?: unknown[]) =>
    (await (state.tx ?? state.db).query(sql, params)).rows,
  pgQueryOne: async (sql: string, params?: unknown[]) =>
    (await (state.tx ?? state.db).query(sql, params)).rows[0] ?? null,
  pgTransaction: async (fn: () => Promise<unknown>) =>
    state.tx
      ? fn()
      : state.db.transaction(async (tx: any) => {
          state.tx = tx
          try {
            return await fn()
          } finally {
            state.tx = null
          }
        }),
  withAdvisoryLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
  pgReadIdentity: async (_identity: unknown, fn: () => Promise<unknown>) => fn(),
}))
vi.mock('@/lib/albums/album-access', () => ({
  requireUploadUser: vi
    .fn()
    .mockResolvedValue({ username: 'alice', role: 'viewer', mainAdmin: false }),
  requireAlbumAccess: vi.fn().mockResolvedValue({ canEdit: true }),
  // The favorites page reports per-photo edit capability; these tests do not assert it.
  canEditAlbum: () => false,
}))
vi.mock('@/lib/upload/ingest-upload', () => ({
  ingestUpload: async (...args: any[]) => args[4](() => state.ingest(...args)),
}))
vi.mock('@/lib/snowflake', () => ({
  querySnowflake: state.sf,
  querySnowflakeStorage: state.sf,
  querySnowflakeLongRunning: state.long,
  getSnowflakeBaseUrl: () => null,
  getRestApiAuthHeader: () => 'Bearer ',
}))
import { completeUpload, saveChunk } from '@/lib/upload/upload-sessions'

vi.mock('@/lib/snowflake/stage-upload', () => ({
  putFilesToStage: state.stage,
  removeFromStage: vi.fn(),
}))
// This schema predates People; these tests cover text indexing, not person search.
vi.mock('@/lib/people/people-search', async (actual) => ({
  ...(await actual<typeof import('@/lib/people/people-search')>()),
  resolvePeople: async (query: string) => ({ people: [], remainder: query }),
  peopleById: async () => [],
  suggestPeople: async () => [],
}))
import { processAllUncategorized } from '@/lib/ai-categorize'
import { syncSearch } from '@/lib/search/search-sync'
import { processImage } from '@/lib/upload/upload-processing'
import sharp from 'sharp'
import { deletePhoto, getAdjacentFavorites, getPhoto } from '@/lib/photos'
import { deleteEvent } from '@/lib/albums/events'
import { deleteFolder } from '@/lib/albums/folders'
import { search } from '@/lib/search'

const id = '11111111-1111-4111-8111-111111111111'
import { updatePhotoLabels } from '@/lib/photos/photo-labels'
import { authorizedPhotoPage, favoritePhotoPage } from '@/lib/photos/photo-page'
// Albums in this fixture take the schema's default owner.
const albumOwner = { username: 'EXAMPLEADMIN', role: 'viewer' as const, mainAdmin: false }
const favoriteItems = async (query = '') =>
  (await favoritePhotoPage(new URLSearchParams(query), albumOwner)).items
const albumPage = (params: URLSearchParams) => authorizedPhotoPage(1, params, albumOwner)
const albumItems = async (query = '') => (await albumPage(new URLSearchParams(query))).items
async function chunk(owner = 'alice', data = 'test', upload = id) {
  const form = new FormData()
  form.set('uploadId', upload)
  form.set('totalChunks', '1')
  form.set('chunkIndex', '0')
  form.set('chunk', new File([data], 'a.jpg'))
  return saveChunk(owner, form)
}
beforeAll(async () => {
  state.db = new PGlite()
  // Minimal enrichment projection for this pre-People fixture; full migration/RLS
  // coverage lives in people-search.test.ts.
  await state.db.exec(
    'CREATE TABLE search_enrichment(photo_id int PRIMARY KEY,source_path text,status text,ocr_text text)',
  )
  await state.db.exec(readFileSync('setup/02-postgres.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/03-add-metadata-columns.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/04-production.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/06-video-600mib.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/07-photo-trash.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/08-reports.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/09-photo-labels.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/34-stage-upload-chunks.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/65-upload-completion-claims.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/19-album-ownership.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/38-ai-prompt-version.sql', 'utf8'))
  await state.db.exec('CREATE ROLE personal_photos_app')
  await state.db.exec(readFileSync('setup/35-personal-costs.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/44-video-ai-costs.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/45-ai-cost-purpose.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/42-video-analysis.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/66-video-analysis-claims.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/57-video-playback.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/58-adaptive-playback.sql', 'utf8'))
  // This legacy schema omits modern statistics triggers; the full migration and
  // deletion behavior are exercised in search-delete-cleanup.test.ts.
  await state.db.exec(
    'ALTER TABLE search_queue ADD COLUMN publication_attempted boolean NOT NULL DEFAULT false',
  )
  await state.db.exec(
    'CREATE TABLE upload_start_limits(owner text PRIMARY KEY,window_start timestamptz NOT NULL DEFAULT now(),starts integer NOT NULL)',
  )
}, 30_000)
afterAll(async () => {
  await state.db?.close()
})
beforeAll(async () => {
  await state.db.exec(`CREATE SCHEMA IF NOT EXISTS photo_security;
 CREATE FUNCTION photo_security.active_upload_count() RETURNS bigint LANGUAGE sql AS $$SELECT count(*) FROM upload_sessions WHERE result IS NULL$$;`)
  await installUploadQueue(state.db)
  await state.db.exec('CREATE TABLE faces(crop_path text)')
  await state.db.exec(
    readFileSync('migrations/postgres/202610291920_stage_cleanup_claims.sql', 'utf8'),
  )
})
beforeEach(async () => {
  await state.db.exec(
    'TRUNCATE storage_retired_paths,faces,video_playback,video_analyses,cost_index_weights,cost_work,upload_start_limits,photo_trash,upload_chunks,upload_sessions,search_queue,photos,events,upload_files,upload_jobs,stage_cleanup RESTART IDENTITY CASCADE',
  )
  state.ingest.mockReset()
  state.sf.mockReset()
  state.long.mockReset()
  state.stage.mockReset()
  await state.db.exec('TRUNCATE maintenance_state')
})
it('runs the migration twice without dropping data', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Morocco','morocco')",
  )
  await state.db.exec(readFileSync('setup/04-production.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/06-video-600mib.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/07-photo-trash.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/08-reports.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/09-photo-labels.sql', 'utf8'))
  expect((await state.db.query('SELECT event_name FROM events')).rows).toEqual([
    { event_name: 'Morocco' },
  ])
})
it('indexes descriptions, plural words, filenames and album metadata in Postgres', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder,event_month,event_year) VALUES(1,'Morocco','morocco',4,2026)",
  )
  await state.db.exec(
    "INSERT INTO photos(event_id,source_filename,ai_description,ai_tags,ingest_status) VALUES(1,'IMG_003.jpg','Two cars parked by the beach',ARRAY['sunset'],'READY')",
  )
  const options = { query: 'car', limit: 20, eventId: null, semantic: false }
  expect((await search('photo', options, [1, 2])).results).toHaveLength(1)
  expect(
    (await search('photo', { ...options, query: 'Morocco April' }, [1, 2])).results,
  ).toHaveLength(1)
  expect((await search('photo', { ...options, query: 'sunset' }, [1, 2])).results).toHaveLength(1)
  expect((await search('event', { ...options, query: 'April 2026' }, [1, 2])).results).toHaveLength(
    1,
  )
  expect(state.sf).not.toHaveBeenCalled()
})
it('queues edits/deletes and reindexes photos when an album is renamed', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'OldPlace','trip'); INSERT INTO photos(event_id,source_filename,ai_description,ingest_status) VALUES(1,'a.jpg','A car','READY')",
  )
  const before = (await state.db.query("SELECT revision FROM search_queue WHERE kind='photo'"))
    .rows[0].revision
  await state.db.exec("UPDATE events SET event_name='NewPlace' WHERE event_id=1")
  expect(
    (await state.db.query("SELECT revision FROM search_queue WHERE kind='photo'")).rows[0].revision,
  ).not.toEqual(before)
  expect(
    (
      await search(
        'photo',
        { query: 'NewPlace', limit: 10, eventId: null, semantic: false },
        [1, 2],
      )
    ).results,
  ).toHaveLength(1)
  await state.db.exec('DELETE FROM photos WHERE photo_id=1')
  expect((await state.db.query("SELECT id FROM search_queue WHERE kind='photo'")).rows).toEqual([
    { id: 1 },
  ])
})
it('searches personal captions and tags immediately, preserves AI, and includes edits in manual sync', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO photos(event_id,source_filename,display_stage_path,ai_description,ai_tags,ingest_status) VALUES(1,'a.jpg','display/a.jpg','A red car',ARRAY['vehicle'],'READY')",
  )
  await state.db.exec('TRUNCATE search_queue')
  await updatePhotoLabels(1, { caption: 'Our anniversary', tags: ['Family', 'roadtrip', 'family'] })
  expect(await getPhoto(1)).toMatchObject({
    caption: 'Our anniversary',
    userTags: ['Family', 'roadtrip'],
    aiDescription: 'A red car',
    aiTags: ['vehicle'],
  })
  for (const query of ['anniversary', 'roadtrip', 'family'])
    expect(
      (await search('photo', { query, limit: 20, eventId: null, semantic: false }, [1, 2])).source,
    ).toBe('postgres')
  expect(state.sf).not.toHaveBeenCalled()
  expect(state.long).not.toHaveBeenCalled()
  expect((await state.db.query("SELECT id FROM search_queue WHERE kind='photo'")).rows).toEqual([
    { id: 1 },
  ])
  await syncSearch({ force: true })
  expect(state.long.mock.calls[0][0]).toContain('Family, roadtrip')
  expect(state.long.mock.calls[0][0]).toContain('Our anniversary')
  await deletePhoto(1)
  const { restorePhotos } = await import('@/lib/photos/photo-management')
  await restorePhotos([1])
  expect(await getPhoto(1)).toMatchObject({
    caption: 'Our anniversary',
    userTags: ['Family', 'roadtrip'],
  })
  await updatePhotoLabels(1, { caption: '', tags: [] })
  expect(await getPhoto(1)).toMatchObject({
    caption: null,
    userTags: [],
    aiDescription: 'A red car',
  })
  expect(
    (
      await state.db.query(
        "SELECT photo_id FROM photos WHERE search_vector @@ websearch_to_tsquery('english','roadtrip')",
      )
    ).rows,
  ).toHaveLength(0)
})
it('lists only ready favorites across albums with matching sorted viewer navigation', async () => {
  await state.db
    .exec(`INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'First','first'),(2,'Second','second');
 INSERT INTO photos(event_id,source_filename,favorite,ingest_status,media_type,date_taken) VALUES
 (1,'b.jpg',true,'READY','photo','2026-01-01'),(2,'a.mov',true,'READY','video','2026-01-02'),
 (2,'c.jpg',false,'READY','photo','2026-01-03'),(1,'d.jpg',true,'FAILED','photo','2026-01-04')`)
  expect((await favoriteItems()).map((p) => [p.photoId, p.eventName])).toEqual([
    [1, 'First'],
    [2, 'Second'],
  ])
  expect(await getAdjacentFavorites(1, new URLSearchParams(), [1, 2])).toEqual({
    prev: null,
    next: 2,
  })
  expect((await favoriteItems('sort=name')).map((p) => p.photoId)).toEqual([2, 1])
  expect(await getAdjacentFavorites(1, new URLSearchParams('sort=name'), [1, 2])).toEqual({
    prev: 2,
    next: null,
  })
  expect((await favoriteItems('media=photo')).map((p) => p.photoId)).toEqual([1])
  await state.db
    .exec(`UPDATE photos SET camera_make='Canon',camera_model='R5',city='Paris' WHERE photo_id=1;
    UPDATE photos SET camera_make='Apple',camera_model='iPhone',city='Rome' WHERE photo_id=2`)
  for (const [query, ids] of [
    ['from=2026-01-02', [2]],
    ['to=2026-01-01', [1]],
    ['camera=canon', [1]],
    ['location=rome', [2]],
    ['camera=canon&location=rome', []],
    ['from=2026-01-01&to=2026-01-01&camera=R5&location=Paris', [1]],
  ] as const) {
    expect((await favoriteItems(query)).map((p) => p.photoId)).toEqual(ids)
  }
  // A favorite in an album the caller cannot read is never listed.
  await state.db.exec("UPDATE events SET owner_username='BOB' WHERE event_id=2")
  expect((await favoriteItems('location=Rome')).map((p) => p.photoId)).toEqual([])
  await state.db.exec("UPDATE events SET owner_username='EXAMPLEADMIN' WHERE event_id=2")
  await deletePhoto(1)
  expect((await favoriteItems()).map((p) => p.photoId)).toEqual([2])
  expect(state.sf).not.toHaveBeenCalled()
  expect(state.long).not.toHaveBeenCalled()
})
it('enforces event/hash uniqueness in the database', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO photos(event_id,source_filename,file_hash) VALUES(1,'a.jpg','same')",
  )
  await expect(
    state.db.exec(
      "INSERT INTO photos(event_id,source_filename,file_hash) VALUES(1,'b.jpg','same')",
    ),
  ).rejects.toMatchObject({ code: '23505' })
})
it('accepts identical chunk retries but rejects changed bytes and another owner', async () => {
  await chunk()
  await chunk()
  expect((await state.db.query('SELECT bytes FROM upload_sessions')).rows[0].bytes).toBe(4)
  await expect(chunk('alice', 'changed')).rejects.toMatchObject({ status: 409 })
  await expect(chunk('bob')).rejects.toMatchObject({ status: 403 })
  expect((await state.db.query('SELECT COUNT(*)::int AS n FROM upload_chunks')).rows[0].n).toBe(1)
})
it('replays a successful completion without re-ingesting', async () => {
  await chunk()
  state.ingest.mockResolvedValue({ eventId: 1, results: [{ status: 'success' }] })
  const body = { uploadId: id, totalChunks: 1, fileName: 'a.jpg', folderName: 'Trip' }
  expect(await completeUpload('alice', body)).toEqual(await completeUpload('alice', body))
  expect(state.ingest).toHaveBeenCalledTimes(1)
  expect((await state.db.query('SELECT COUNT(*)::int AS n FROM upload_chunks')).rows[0].n).toBe(0)
  await expect(completeUpload('alice', { ...body, folderName: 'Other' })).rejects.toMatchObject({
    status: 409,
  })
})
it('preserves chunks after processing failure and allows a safe retry', async () => {
  await chunk()
  state.ingest
    .mockRejectedValueOnce(new Error('stage unavailable'))
    .mockResolvedValueOnce({ eventId: 1, results: [] })
  const body = { uploadId: id, totalChunks: 1, fileName: 'a.jpg', folderName: 'Trip' }
  await expect(completeUpload('alice', body)).rejects.toThrow('stage unavailable')
  expect((await state.db.query('SELECT COUNT(*)::int AS n FROM upload_chunks')).rows[0].n).toBe(1)
  await expect(completeUpload('alice', body)).resolves.toMatchObject({ eventId: 1 })
})

it('automatically describes a pending photo and never re-runs a completed description', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO photos(event_id,source_filename,file_hash,display_stage_path,ingest_status) VALUES(1,'a.jpg','hash','display/a.jpg','READY')",
  )
  state.long.mockResolvedValue([
    { RESULT: JSON.stringify({ description: 'A red car', tags: ['car', 'red'] }) },
  ])
  expect((await processAllUncategorized()).processed).toBe(1)
  expect((await processAllUncategorized()).processed).toBe(0)
  expect(state.long).toHaveBeenCalledTimes(1)
  expect(
    (await state.db.query('SELECT ai_description,ai_claim,ai_prompt_version FROM photos')).rows[0],
  ).toMatchObject({
    ai_description: 'A red car',
    ai_claim: null,
    ai_prompt_version: 'v3-sonnet46-recognition',
  })
})
it('persists AI failure and delays retry instead of looping on the same photo', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO photos(event_id,source_filename,display_stage_path,ingest_status) VALUES(1,'a.jpg','display/a.jpg','READY')",
  )
  state.long.mockRejectedValue(new Error('Cortex unavailable'))
  expect((await processAllUncategorized()).errors).toHaveLength(1)
  expect((await processAllUncategorized()).processed).toBe(0)
  expect(state.long).toHaveBeenCalledTimes(1)
  expect(
    (
      await state.db.query(
        'SELECT ai_attempts, ai_error, ai_next_attempt_at>NOW() AS delayed FROM photos',
      )
    ).rows[0],
  ).toMatchObject({ ai_attempts: 1, delayed: true, ai_error: 'Cortex unavailable' })
})
it('reuses descriptions for identical content in another event', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'),(2,'Other','other'); INSERT INTO photos(event_id,source_filename,file_hash,display_stage_path,ingest_status,ai_description,ai_prompt_version) VALUES(1,'a.jpg','same','display/a.jpg','READY','A car','v3-sonnet46-recognition'),(2,'b.jpg','same','display/b.jpg','READY',NULL,NULL)",
  )
  expect((await processAllUncategorized()).processed).toBe(1)
  expect(state.long).not.toHaveBeenCalled()
  expect(
    (await state.db.query('SELECT ai_prompt_version FROM photos WHERE photo_id=2')).rows[0]
      .ai_prompt_version,
  ).toBe('v3-sonnet46-recognition')
})
it('never syncs automatically, even with queued changes', async () => {
  await syncSearch()
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip')",
  )
  await syncSearch()
  expect(state.sf).not.toHaveBeenCalled()
  expect(state.long).not.toHaveBeenCalled()
  expect((await state.db.query('SELECT id FROM search_queue')).rows).toHaveLength(1)
})
it('manually refreshes both suspended indexes even with an empty queue', async () => {
  await syncSearch({ force: true })
  expect(state.sf.mock.calls.map((c) => c[0])).toEqual([
    'ALTER CORTEX SEARCH SERVICE PERSONAL_MEDIA.DATA.PHOTO_SEARCH_SERVICE SUSPEND INDEXING',
    'ALTER CORTEX SEARCH SERVICE PERSONAL_MEDIA.DATA.EVENT_SEARCH_SERVICE SUSPEND INDEXING',
  ])
  expect(state.long.mock.calls.map((c) => c[0])).toEqual([
    'ALTER CORTEX SEARCH SERVICE PERSONAL_MEDIA.DATA.PHOTO_SEARCH_SERVICE REFRESH',
    'ALTER CORTEX SEARCH SERVICE PERSONAL_MEDIA.DATA.EVENT_SEARCH_SERVICE REFRESH',
  ])
})
it('retries index failure after table changes were acknowledged without resuming indexing', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip')",
  )
  state.long.mockImplementation(async (sql: string) => {
    if (sql.endsWith(' REFRESH')) throw new Error('Index unavailable')
    return []
  })
  await expect(syncSearch({ force: true })).rejects.toThrow('Index unavailable')
  expect((await state.db.query('SELECT * FROM search_queue')).rows).toHaveLength(0)
  expect(
    (
      await state.db.query(
        "SELECT last_error,last_success FROM maintenance_state WHERE name='search-sync'",
      )
    ).rows[0],
  ).toMatchObject({ last_error: 'Index unavailable', last_success: null })
  state.long.mockResolvedValue([])
  await syncSearch({ force: true })
  expect(
    (await state.db.query("SELECT last_error FROM maintenance_state WHERE name='search-sync'"))
      .rows[0].last_error,
  ).toBeNull()
  expect(state.sf.mock.calls.every((c) => !c[0].includes('RESUME'))).toBe(true)
})
it('marks remote records discovered by full repair before publishing or cancellation', async () => {
  state.sf.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT PHOTO_ID AS ID')) return [{ ID: 777 }]
    if (sql.startsWith('SELECT EVENT_ID AS ID')) return []
    if (sql.endsWith('SUSPEND INDEXING')) {
      expect(
        (
          await state.db.query(
            "SELECT publication_attempted FROM search_queue WHERE kind='photo' AND id=777",
          )
        ).rows,
      ).toEqual([{ publication_attempted: true }])
    }
    return []
  })
  state.long.mockResolvedValue([])
  await syncSearch({ force: true, full: true })
  expect((await state.db.query('SELECT * FROM search_queue')).rows).toEqual([])
})
it('propagates deletes without clearing the entire search table', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO photos(event_id,source_filename,display_stage_path,ingest_status) VALUES(1,'a.jpg','display/a.jpg','READY'); DELETE FROM photos WHERE photo_id=1",
  )
  state.sf.mockResolvedValue([])
  state.long.mockResolvedValue([])
  await syncSearch({ force: true })
  expect(
    state.sf.mock.calls.some(([sql]: string[]) =>
      sql.includes('DELETE FROM PERSONAL_MEDIA.DATA.PHOTO_SEARCH_DATA WHERE PHOTO_ID IN (?)'),
    ),
  ).toBe(true)
  expect((await state.db.query('SELECT * FROM search_queue')).rows).toHaveLength(0)
})
it('does not lose an edit that arrives during a semantic merge', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'First','trip')",
  )
  state.long
    .mockImplementationOnce(async () => {
      await state.db.exec("UPDATE events SET event_name='Second' WHERE event_id=1")
      return []
    })
    .mockResolvedValue([])
  await syncSearch({ force: true })
  expect(state.long).toHaveBeenCalledTimes(4)
  expect(state.long.mock.calls[1][0]).toContain('Second')
})
it('stores same-named images under different keys and rejects malformed image bytes', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO upload_jobs(event_id) VALUES(1)",
  )
  const red = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } })
    .jpeg()
    .toBuffer()
  const blue = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'blue' } })
    .jpeg()
    .toBuffer()
  await processImage(red, 'same.jpg', 'jpg', 'trip', 1, 1)
  await processImage(blue, 'same.jpg', 'jpg', 'trip', 1, 1)
  const paths = (await state.db.query('SELECT original_stage_path FROM photos')).rows.map(
    (p: any) => p.original_stage_path,
  )
  expect(new Set(paths).size).toBe(2)
  const result = await processImage(red, 'another.jpg', 'jpg', 'trip', 1, 1)
  expect(result.status).toBe('skipped')
  await expect(
    processImage(Buffer.from('not an image'), 'bad.jpg', 'jpg', 'trip', 1, 1),
  ).rejects.toMatchObject({ status: 422 })
  expect(state.stage).toHaveBeenCalledTimes(2)
})

it('repairs a trashed cover and retains storage during the restore window', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder,cover_photo_id) VALUES(1,'Trip','trip',1); INSERT INTO photos(event_id,source_filename,original_stage_path,ingest_status) VALUES(1,'a.jpg','originals/a.jpg','READY'),(1,'b.jpg','originals/b.jpg','READY')",
  )
  await deletePhoto(1)
  expect((await state.db.query('SELECT cover_photo_id,photo_count FROM events')).rows[0]).toEqual({
    cover_photo_id: 2,
    photo_count: 1,
  })
  expect((await state.db.query('SELECT path FROM stage_cleanup')).rows).toEqual([])
  expect((await state.db.query('SELECT photo_id FROM photo_trash')).rows).toEqual([{ photo_id: 1 }])
})
it('deletes an event while retaining restorable photos and search tombstones', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO photos(event_id,source_filename,original_stage_path) VALUES(1,'a.jpg','originals/a.jpg'); INSERT INTO upload_jobs(event_id) VALUES(1); INSERT INTO upload_files(upload_job_id,source_filename) VALUES(1,'a.jpg')",
  )
  await deleteEvent(1)
  expect((await state.db.query('SELECT * FROM events')).rows).toHaveLength(0)
  expect((await state.db.query('SELECT * FROM upload_files')).rows).toHaveLength(0)
  expect((await state.db.query('SELECT path FROM stage_cleanup')).rows).toHaveLength(0)
  expect((await state.db.query('SELECT photo_id FROM photo_trash')).rows).toHaveLength(1)
  expect((await state.db.query('SELECT kind FROM search_queue ORDER BY kind')).rows).toEqual([
    { kind: 'event' },
    { kind: 'photo' },
  ])
})
it('moves events out of a deleted folder in a transaction', async () => {
  await state.db.exec(
    "INSERT INTO folders(folder_name) VALUES('Trips'); INSERT INTO events(sort_order,event_name,source_folder,folder_id) VALUES(1,'Trip','trip',1)",
  )
  await deleteFolder(1)
  expect((await state.db.query('SELECT folder_id FROM events')).rows).toEqual([{ folder_id: null }])
  expect((await state.db.query('SELECT * FROM folders WHERE folder_id=1')).rows).toEqual([])
})

it('deletes an empty upload folder without removing unrelated folders or albums', async () => {
  const empty = (
    await state.db.query(
      "INSERT INTO folders(folder_name) VALUES('Empty test') RETURNING folder_id",
    )
  ).rows[0].folder_id
  const keep = (
    await state.db.query("INSERT INTO folders(folder_name) VALUES('Keep') RETURNING folder_id")
  ).rows[0].folder_id
  await state.db.query(
    "INSERT INTO events(sort_order,event_name,source_folder,folder_id) VALUES(1,'Keep album','keep',$1)",
    [keep],
  )
  await deleteFolder(empty)
  expect(
    (await state.db.query('SELECT folder_id FROM folders WHERE folder_id=$1', [empty])).rows,
  ).toEqual([])
  expect(
    (await state.db.query('SELECT folder_id,folder_name FROM folders WHERE folder_id=$1', [keep]))
      .rows,
  ).toEqual([{ folder_id: keep, folder_name: 'Keep' }])
  expect((await state.db.query('SELECT folder_id,event_name FROM events')).rows).toEqual([
    { folder_id: keep, event_name: 'Keep album' },
  ])
})

it('allows 600 MiB and 75 chunks but rejects larger sessions', async () => {
  await state.db.exec(readFileSync('setup/06-video-600mib.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/07-photo-trash.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/08-reports.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/09-photo-labels.sql', 'utf8'))
  await state.db.query(
    "INSERT INTO upload_sessions(upload_id,owner,total_chunks,bytes) VALUES($1,'alice',75,629145600)",
    [id],
  )
  await state.db.query(
    "INSERT INTO upload_chunks(upload_id,chunk_index,data,hash) VALUES($1,74,$2,'test')",
    [id, Buffer.from('test')],
  )
  await expect(
    state.db.query('UPDATE upload_sessions SET bytes=629145601 WHERE upload_id=$1', [id]),
  ).rejects.toMatchObject({ code: '23514' })
  await expect(
    state.db.query('UPDATE upload_sessions SET total_chunks=76 WHERE upload_id=$1', [id]),
  ).rejects.toMatchObject({ code: '23514' })
  await expect(
    state.db.query('UPDATE upload_chunks SET chunk_index=75 WHERE upload_id=$1', [id]),
  ).rejects.toMatchObject({ code: '23514' })
})

it('keeps an explicitly selected cover when more photos are uploaded', async () => {
  const { chooseCoverPhoto, setCoverPhoto } = await import('@/lib/albums/events')
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO photos(event_id,source_filename,ingest_status,thumbnail_stage_path) VALUES(1,'first.jpg','READY','thumbnails/first.jpg'),(1,'chosen.jpg','READY','thumbnails/chosen.jpg'),(1,'later.jpg','READY','thumbnails/later.jpg')",
  )
  await setCoverPhoto(1, 1)
  expect(await chooseCoverPhoto(2)).toBe(true)
  await setCoverPhoto(1, 3)
  expect(
    (await state.db.query('SELECT cover_photo_id FROM events WHERE event_id=1')).rows[0]
      .cover_photo_id,
  ).toBe(2)
  expect(await chooseCoverPhoto(999)).toBe(false)
})

it('returns the existing filename and photo link ID for identical bytes', async () => {
  const { createHash } = await import('node:crypto')
  const bytes = Buffer.from('identical photo bytes')
  const hash = createHash('sha256').update(bytes).digest('hex')
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO upload_jobs(event_id,source_folder,file_count,status) VALUES(1,'trip',1,'IN_PROGRESS')",
  )
  await state.db.query(
    "INSERT INTO photos(event_id,source_filename,file_hash,ingest_status) VALUES(1,'original.jpg',$1,'READY')",
    [hash],
  )
  const result = await processImage(bytes, 'renamed.jpg', 'jpg', 'trip', 1, 1)
  expect(result).toMatchObject({ status: 'skipped', photoId: 1, existingFilename: 'original.jpg' })
  expect(result.error).toBeUndefined()
  expect(state.stage).not.toHaveBeenCalled()
})

it('restores metadata, search visibility, counts and cover without storage deletion', async () => {
  const { restorePhotos } = await import('@/lib/photos/photo-management')
  const { getPhoto } = await import('@/lib/photos')
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder,cover_photo_id,photo_count) VALUES(1,'Trip','trip',1,1); INSERT INTO photos(event_id,source_filename,file_hash,original_stage_path,thumbnail_stage_path,ingest_status,ai_description,favorite) VALUES(1,'a.jpg','hash','originals/a.jpg','thumbnails/a.jpg','READY','A red car',true)",
  )
  await deletePhoto(1)
  expect(await getPhoto(1)).toBeNull()
  expect(
    (
      await state.db.query(
        "SELECT photo_id FROM photos WHERE search_vector @@ websearch_to_tsquery('english','car')",
      )
    ).rows,
  ).toHaveLength(0)
  await restorePhotos([1])
  expect(await getPhoto(1)).toMatchObject({
    favorite: true,
    aiDescription: 'A red car',
    fileHash: 'hash',
  })
  expect(
    (await search('photo', { query: 'car', limit: 20, eventId: null, semantic: false }, [1, 2]))
      .results,
  ).toHaveLength(1)
  expect((await state.db.query('SELECT photo_count,cover_photo_id FROM events')).rows[0]).toEqual({
    photo_count: 1,
    cover_photo_id: 1,
  })
  expect((await state.db.query('SELECT * FROM stage_cleanup')).rows).toHaveLength(0)
})
it('restores photos from a deleted album into a chosen destination', async () => {
  const { restorePhotos } = await import('@/lib/photos/photo-management')
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Old','old'),(2,'New','new'); INSERT INTO photos(event_id,source_filename,ingest_status) VALUES(1,'a.jpg','READY')",
  )
  await deleteEvent(1)
  await expect(restorePhotos([1])).rejects.toMatchObject({ status: 409 })
  await restorePhotos([1], 2)
  expect((await state.db.query('SELECT event_id FROM photos')).rows[0].event_id).toBe(2)
})
it('moves atomically and repairs both albums; duplicate conflicts lose no photos', async () => {
  const { bulkPhotos } = await import('@/lib/photos/photo-management')
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder,cover_photo_id) VALUES(1,'One','one',1),(2,'Two','two',3); INSERT INTO photos(event_id,source_filename,file_hash,ingest_status,thumbnail_stage_path) VALUES(1,'a.jpg','same','READY','thumbnails/a.jpg'),(1,'b.jpg','other','READY','thumbnails/b.jpg'),(2,'c.jpg','same','READY','thumbnails/c.jpg')",
  )
  await expect(bulkPhotos([1, 2], 'move', 2)).rejects.toMatchObject({ status: 409 })
  expect(
    (await state.db.query('SELECT photo_id FROM photos WHERE event_id=1 ORDER BY photo_id')).rows,
  ).toHaveLength(2)
  await bulkPhotos([2], 'move', 2)
  expect((await state.db.query('SELECT photo_count FROM events ORDER BY event_id')).rows).toEqual([
    { photo_count: 1 },
    { photo_count: 2 },
  ])
  await bulkPhotos([1], 'favorite')
  expect(
    (await state.db.query('SELECT favorite FROM photos WHERE photo_id=1')).rows[0].favorite,
  ).toBe(true)
  await bulkPhotos([1], 'trash')
  expect(
    (await state.db.query('SELECT cover_photo_id FROM events WHERE event_id=1')).rows[0]
      .cover_photo_id,
  ).toBeNull()
})
it('trashes and restores several photos across albums in one operation', async () => {
  const { bulkPhotos, restorePhotos } = await import('@/lib/photos/photo-management')
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder,cover_photo_id) VALUES(1,'One','one',1),(2,'Two','two',3); INSERT INTO photos(event_id,source_filename,file_hash,ingest_status,thumbnail_stage_path) VALUES(1,'a.jpg','a','READY','thumbnails/a.jpg'),(1,'b.jpg','b','READY','thumbnails/b.jpg'),(2,'c.jpg','c','READY','thumbnails/c.jpg'),(2,'d.jpg','d','READY','thumbnails/d.jpg')",
  )
  const albums = async () =>
    (
      await state.db.query(
        'SELECT event_id,photo_count,cover_photo_id FROM events ORDER BY event_id',
      )
    ).rows
  expect(await bulkPhotos([1, 3, 4], 'trash')).toEqual({ count: 3 })
  // The deleted cover of album one is replaced; album two is empty and has none.
  expect(await albums()).toEqual([
    { event_id: 1, photo_count: 1, cover_photo_id: 2 },
    { event_id: 2, photo_count: 0, cover_photo_id: null },
  ])
  expect(
    (await state.db.query('SELECT photo_id,album_name FROM photo_trash ORDER BY photo_id')).rows,
  ).toEqual([
    { photo_id: 1, album_name: 'One' },
    { photo_id: 3, album_name: 'Two' },
    { photo_id: 4, album_name: 'Two' },
  ])
  expect(await restorePhotos([1, 3, 4])).toEqual({ count: 3 })
  expect((await state.db.query('SELECT photo_id FROM photo_trash')).rows).toHaveLength(0)
  expect(
    (await state.db.query('SELECT photo_id,event_id FROM photos ORDER BY photo_id')).rows,
  ).toEqual([
    { photo_id: 1, event_id: 1 },
    { photo_id: 2, event_id: 1 },
    { photo_id: 3, event_id: 2 },
    { photo_id: 4, event_id: 2 },
  ])
  expect(await albums()).toEqual([
    { event_id: 1, photo_count: 2, cover_photo_id: 2 },
    { event_id: 2, photo_count: 2, cover_photo_id: 3 },
  ])
})
it('leaves all files in Trash when any restore conflicts', async () => {
  const { restorePhotos } = await import('@/lib/photos/photo-management')
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO photos(event_id,source_filename,file_hash) VALUES(1,'a.jpg','one'),(1,'b.jpg','two')",
  )
  await deletePhoto(1)
  await deletePhoto(2)
  await state.db.exec(
    "INSERT INTO photos(event_id,source_filename,file_hash) VALUES(1,'new.jpg','two')",
  )
  await expect(restorePhotos([1, 2])).rejects.toMatchObject({ status: 409 })
  expect((await state.db.query('SELECT photo_id FROM photo_trash')).rows).toHaveLength(2)
  expect((await state.db.query('SELECT photo_id FROM photos')).rows).toHaveLength(1)
})
it('protects retained media from orphan cleanup and only purges expired trash', async () => {
  const { purgeExpiredTrash, restorePhotos } = await import('@/lib/photos/photo-management')
  const { cleanupStage } = await vi.importActual<typeof import('@/lib/snowflake/stage-upload')>(
    '@/lib/snowflake/stage-upload',
  )
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO photos(event_id,source_filename,original_stage_path) VALUES(1,'a.jpg','originals/a.jpg')",
  )
  await deletePhoto(1)
  await state.db.exec("INSERT INTO stage_cleanup(path) VALUES('originals/a.jpg')")
  await cleanupStage()
  expect(state.sf).not.toHaveBeenCalled()
  await purgeExpiredTrash()
  expect((await state.db.query('SELECT photo_id FROM photo_trash')).rows).toHaveLength(1)
  await state.db.exec("UPDATE photo_trash SET expires_at=NOW()-INTERVAL '1 second'")
  await expect(restorePhotos([1])).rejects.toMatchObject({ status: 409 })
  await purgeExpiredTrash()
  expect((await state.db.query('SELECT photo_id FROM photo_trash')).rows).toHaveLength(0)
  expect((await state.db.query('SELECT path FROM stage_cleanup')).rows).toEqual([
    { path: 'originals/a.jpg' },
  ])
})
it.each([true, false])(
  'stores video capture times with ftyp=%s and interleaves videos with photos',
  async (withFtyp) => {
    const { processVideo } = await import('@/lib/upload/upload-processing')
    await state.db.exec(
      "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO upload_jobs(event_id) VALUES(1); INSERT INTO photos(event_id,source_filename,ingest_status,date_taken) VALUES(1,'before.jpg','READY','2026-06-03T19:00:00Z'),(1,'after.jpg','READY','2026-06-03T21:00:00Z')",
    )
    const buffer = Buffer.alloc(49)
    buffer.writeUInt32BE(16, 0)
    buffer.write('ftyp', 4)
    buffer.writeUInt32BE(24, 16)
    buffer.write('moov', 20)
    buffer.writeUInt32BE(16, 24)
    buffer.write('mvhd', 28)
    buffer.writeUInt32BE(Date.parse('2026-06-03T20:00:00Z') / 1000 + 2082844800, 36)
    buffer.writeUInt32BE(9, 40)
    buffer.write('mdat', 44)
    await processVideo(withFtyp ? buffer : buffer.subarray(16), 'middle.mov', 'mov', 'Trip', 1, 1)
    const photos = await albumItems()
    expect(photos.map((p) => p.sourceFilename)).toEqual(['before.jpg', 'middle.mov', 'after.jpg'])
    expect((await getPhoto(photos[1].photoId))?.dateTaken).toBe('2026-06-03T20:00:00.000Z')
  },
)
it('a client video poster that cannot be decoded never fails the upload', async () => {
  const { processVideo } = await import('@/lib/upload/upload-processing')
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO upload_jobs(event_id) VALUES(1)",
  )
  const buffer = Buffer.alloc(49)
  buffer.writeUInt32BE(16, 0)
  buffer.write('ftyp', 4)
  buffer.writeUInt32BE(24, 16)
  buffer.write('moov', 20)
  buffer.writeUInt32BE(16, 24)
  buffer.write('mvhd', 28)
  buffer.writeUInt32BE(Date.parse('2026-06-03T20:00:00Z') / 1000 + 2082844800, 36)
  buffer.writeUInt32BE(9, 40)
  buffer.write('mdat', 44)
  // One junk byte previously threw after the whole video had been prepared.
  await processVideo(buffer, 'clip.mov', 'mov', 'Trip', 1, 1, Buffer.from([0]))
  expect(
    (await state.db.query("SELECT ingest_status FROM photos WHERE source_filename='clip.mov'"))
      .rows,
  ).toEqual([{ ingest_status: 'READY' }])
})
it('a server-made video poster that cannot be normalized fails the attempt so it is retried', async () => {
  const transforms = await import('@/lib/video/transforms')
  const poster = vi.spyOn(transforms, 'videoPoster').mockResolvedValue(Buffer.from([0]))
  try {
    const { processVideo } = await import('@/lib/upload/upload-processing')
    await state.db.exec(
      "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO upload_jobs(event_id) VALUES(1)",
    )
    const buffer = Buffer.alloc(49)
    buffer.writeUInt32BE(16, 0)
    buffer.write('ftyp', 4)
    buffer.writeUInt32BE(24, 16)
    buffer.write('moov', 20)
    buffer.writeUInt32BE(16, 24)
    buffer.write('mvhd', 28)
    buffer.writeUInt32BE(Date.parse('2026-06-03T20:00:00Z') / 1000 + 2082844800, 36)
    buffer.writeUInt32BE(9, 40)
    buffer.write('mdat', 44)
    await expect(processVideo(buffer, 'clip.mov', 'mov', 'Trip', 1, 1)).rejects.toThrow()
    expect(poster).toHaveBeenCalled()
  } finally {
    poster.mockRestore()
  }
})
it('keeps default viewer navigation in gallery order when capture timestamps tie', async () => {
  const { getPhotoViewerPage } = await import('@/lib/photos')
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO photos(event_id,source_filename,ingest_status,date_taken) VALUES(1,'z.jpg','READY','2026-01-01'),(1,'a.jpg','READY','2026-01-01'),(1,'m.jpg','READY','2026-01-02')",
  )
  const photos = await albumItems()
  expect(photos).toHaveLength(3)
  for (let i = 0; i < photos.length; i++)
    expect((await getPhotoViewerPage(photos[i].photoId, albumOwner))?.adjacent).toMatchObject({
      prev: photos[i - 1]?.photoId ?? null,
      next: photos[i + 1]?.photoId ?? null,
    })
})
it('filters and sorts in Postgres using literal camera/location text', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO photos(event_id,source_filename,ingest_status,media_type,favorite,date_taken,camera_model,city) VALUES(1,'b.jpg','READY','photo',true,'2026-01-01','iPhone','Paris'),(1,'a.mp4','READY','video',false,'2026-02-01','Canon','Denver')",
  )
  expect(
    (await albumItems('favorite=true&camera=phone&location=Paris&media=photo&to=2026-01-01')).map(
      (p) => p.sourceFilename,
    ),
  ).toEqual(['b.jpg'])
  expect((await albumItems('sort=newest')).map((p) => p.sourceFilename)).toEqual(['a.mp4', 'b.jpg'])
  expect(await albumItems('location=%25')).toHaveLength(0)
  await expect(albumItems('sort=DROP TABLE photos')).rejects.toMatchObject({ status: 400 })
  await expect(albumItems('from=2026-02-30')).rejects.toMatchObject({ status: 400 })
})
it('permanently removes selected Trash records and keeps shared live storage protected', async () => {
  const { permanentlyDeleteTrash } = await import('@/lib/photos/photo-management')
  const { cleanupStage } = await vi.importActual<typeof import('@/lib/snowflake/stage-upload')>(
    '@/lib/snowflake/stage-upload',
  )
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'),(2,'Other','other'); INSERT INTO photos(event_id,source_filename,original_stage_path,ingest_status) VALUES(1,'a.jpg','originals/shared.jpg','READY'),(2,'b.jpg','originals/shared.jpg','READY')",
  )
  await deletePhoto(1)
  expect(await permanentlyDeleteTrash([1])).toEqual({ count: 1 })
  expect((await state.db.query('SELECT * FROM photo_trash')).rows).toHaveLength(0)
  await cleanupStage()
  expect(state.sf).not.toHaveBeenCalled()
  expect((await state.db.query('SELECT photo_id FROM photos')).rows).toEqual([{ photo_id: 2 }])
  await expect(permanentlyDeleteTrash([2])).rejects.toMatchObject({ status: 409 })
})
it('empties Trash with durable storage deletion intents', async () => {
  const { permanentlyDeleteTrash } = await import('@/lib/photos/photo-management')
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO photos(event_id,source_filename,original_stage_path) VALUES(1,'a.jpg','originals/a.jpg'),(1,'b.jpg','originals/b.jpg')",
  )
  await deletePhoto(1)
  await deletePhoto(2)
  expect(await permanentlyDeleteTrash(null)).toEqual({ count: 2 })
  expect((await state.db.query('SELECT path FROM stage_cleanup ORDER BY path')).rows).toEqual([
    { path: 'originals/a.jpg' },
    { path: 'originals/b.jpg' },
  ])
})
it('stores only references for new chunks and still completes legacy database chunks', async () => {
  await chunk()
  const row = (await state.db.query('SELECT data,stage_path,byte_size FROM upload_chunks')).rows[0]
  expect(row.data).toBeNull()
  expect(row.stage_path).toMatch(/^upload-chunks\//)
  expect(row.byte_size).toBe(4)
  await state.db.query('UPDATE upload_chunks SET data=$1,stage_path=NULL,byte_size=NULL', [
    Buffer.from('test'),
  ])
  state.ingest.mockResolvedValue({ eventId: 1, results: [] })
  await completeUpload('alice', {
    uploadId: id,
    totalChunks: 1,
    fileName: 'a.jpg',
    folderName: 'Trip',
  })
  expect(state.ingest.mock.calls[0][0]).toEqual(Buffer.from('test'))
})
it('does not remove referenced staged chunks; cleans after session removal', async () => {
  await chunk()
  const path = (await state.db.query('SELECT stage_path FROM upload_chunks')).rows[0].stage_path
  await state.db.query('INSERT INTO stage_cleanup(path,next_attempt) VALUES($1,NOW())', [path])
  const { cleanupStage } = await vi.importActual<typeof import('@/lib/snowflake/stage-upload')>(
    '@/lib/snowflake/stage-upload',
  )
  await cleanupStage()
  expect(state.sf).not.toHaveBeenCalled()
  await state.db.query('DELETE FROM upload_sessions')
  await state.db.query('UPDATE stage_cleanup SET next_attempt=NOW()')
  state.sf.mockResolvedValue([])
  await cleanupStage()
  expect(state.sf).toHaveBeenCalledOnce()
  expect((await state.db.query('SELECT * FROM stage_cleanup')).rows).toHaveLength(0)
})

it('backfills only unversioned descriptions and preserves versions on repeated migration', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO photos(event_id,source_filename,ai_description,ai_prompt_version) VALUES(1,'old.jpg','Original',NULL),(1,'new.jpg','New','v2-factual'),(1,'pending.jpg',NULL,NULL)",
  )
  for (let i = 0; i < 2; i++)
    await state.db.exec(readFileSync('setup/38-ai-prompt-version.sql', 'utf8'))
  expect(
    (await state.db.query('SELECT ai_description,ai_prompt_version FROM photos ORDER BY photo_id'))
      .rows,
  ).toEqual([
    { ai_description: 'Original', ai_prompt_version: 'legacy' },
    { ai_description: 'New', ai_prompt_version: 'v2-factual' },
    { ai_description: null, ai_prompt_version: null },
  ])
})

it('runs eight AI calls concurrently, never more, and processes each photo once', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO photos(event_id,source_filename,file_hash,display_stage_path,ingest_status) SELECT 1,'p'||i||'.jpg','hash'||i,'display/'||i||'.jpg','READY' FROM generate_series(1,17) i",
  )
  let active = 0
  let peak = 0
  const releases: Array<() => void> = []
  state.long.mockImplementation(async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise<void>((resolve) => releases.push(resolve))
    active--
    return [{ RESULT: JSON.stringify({ description: 'A boat', tags: ['boat'] }) }]
  })
  const running = processAllUncategorized()
  await vi.waitFor(() => expect(releases).toHaveLength(8))
  expect(active).toBe(8)
  releases.splice(0).forEach((release) => release())
  await vi.waitFor(() => expect(releases).toHaveLength(8))
  releases.splice(0).forEach((release) => release())
  await vi.waitFor(() => expect(releases).toHaveLength(1))
  releases.splice(0).forEach((release) => release())
  expect(await running).toEqual({ processed: 17, errors: [] })
  expect(peak).toBe(8)
  expect(state.long).toHaveBeenCalledTimes(17)
  expect(
    (
      await state.db.query(
        "SELECT count(*)::int n FROM photos WHERE ai_prompt_version='v3-sonnet46-recognition' AND ai_attempts=1 AND ai_claim IS NULL",
      )
    ).rows[0].n,
  ).toBe(17)
})

it('video analysis joins keyword and manual AI search without touching the original', async () => {
  await state.db.exec(readFileSync('setup/42-video-analysis.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/66-video-analysis-claims.sql', 'utf8'))
  await state.db.exec(readFileSync('setup/57-video-playback.sql', 'utf8'))
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO photos(event_id,source_filename,media_type,original_stage_path,display_stage_path,ingest_status) VALUES(1,'clip.mov','video','originals/clip.mov','originals/clip.mov','READY')",
  )
  await state.db.exec(
    "INSERT INTO video_analyses(id,photo_id,requested_by,owner_username,model,prompt_version,status,search_text) VALUES('11111111-1111-4111-8111-111111111111',1,'ADMIN','alice','gemini-3.1-pro','video-v1','completed','A guitarist says bonjour and plays flamenco'); UPDATE photos SET updated_at=NOW() WHERE photo_id=1",
  )
  expect(
    (await search('photo', { query: 'flamenco', limit: 20, eventId: null, semantic: false }, [1]))
      .results,
  ).toHaveLength(1)
  expect(
    (await state.db.query('SELECT original_stage_path FROM photos WHERE photo_id=1')).rows[0]
      .original_stage_path,
  ).toBe('originals/clip.mov')
  await syncSearch({ force: true })
  expect(state.long.mock.calls[0][0]).toContain('bonjour')
  await deletePhoto(1)
  expect((await state.db.query('SELECT id FROM video_analyses')).rows).toHaveLength(1)
  const { restorePhotos } = await import('@/lib/photos/photo-management')
  await restorePhotos([1])
  expect(
    (await search('photo', { query: 'flamenco', limit: 20, eventId: null, semantic: false }, [1]))
      .results,
  ).toHaveLength(1)
})

it('admits independent replica completions without a global ceiling, fences expired owners, and publishes atomically', async () => {
  const {
    claimUploadCompletion,
    renewUploadCompletion,
    publishUploadCompletion,
    releaseUploadCompletion,
  } = await import('@/lib/upload/upload-completion-claim')
  const ids = [id, '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
  for (const value of ids) await chunk('alice', 'test', value)
  const a = await claimUploadCompletion(ids[0], 'alice')
  const b = await claimUploadCompletion(ids[1], 'alice')
  expect(a.token).toBeTruthy()
  expect(b.token).toBeTruthy()
  expect((await claimUploadCompletion(ids[2], 'alice')).token).toBeTruthy()
  await expect(claimUploadCompletion(ids[0], 'alice')).rejects.toMatchObject({ status: 429 })
  await state.db.query(
    "UPDATE upload_sessions SET completion_lease_until=NOW()-INTERVAL '1 second' WHERE upload_id=$1",
    [ids[0]],
  )
  const replacement = await claimUploadCompletion(ids[0], 'alice')
  expect(await renewUploadCompletion(ids[0], a.token!)).toBe(false)
  const stale = vi.fn()
  await expect(publishUploadCompletion(ids[0], 'alice', a.token!, stale)).rejects.toMatchObject({
    status: 409,
  })
  expect(stale).not.toHaveBeenCalled()
  await releaseUploadCompletion(ids[0], a.token!)
  expect(await renewUploadCompletion(ids[0], replacement.token!)).toBe(true)
  await expect(
    publishUploadCompletion(ids[0], 'alice', replacement.token!, async () => {
      throw Error('publication failed')
    }),
  ).rejects.toThrow('publication failed')
  expect(
    (await state.db.query('SELECT result FROM upload_sessions WHERE upload_id=$1', [ids[0]]))
      .rows[0].result,
  ).toBeNull()
  await publishUploadCompletion(ids[0], 'alice', replacement.token!, async () => ({ eventId: 1 }))
  expect((await claimUploadCompletion(ids[0], 'alice')).result).toEqual({ eventId: 1 })
  expect(
    (await state.db.query('SELECT * FROM upload_chunks WHERE upload_id=$1', [ids[0]])).rows,
  ).toHaveLength(0)
})

it('prepares media without publishing catalog rows and rechecks duplicates on publication', async () => {
  const { prepareImage } = await import('@/lib/upload/upload-processing')
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO upload_jobs(event_id) VALUES(1)",
  )
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .jpeg()
    .toBuffer()
  const first = await prepareImage(bytes, 'a.jpg', 'jpg', 'trip', 1)
  const second = await prepareImage(bytes, 'b.jpg', 'jpg', 'trip', 1)
  expect((await state.db.query('SELECT * FROM photos')).rows).toHaveLength(0)
  const a = await first(1)
  const b = await second(1)
  expect(a.status).toBe('success')
  expect(b.status).toBe('skipped')
  expect(b.photoId).toBe(a.photoId)
})

it('publishes HEIC originals unchanged with JPEG renditions from decoded pixels', async () => {
  const { createHash } = await import('node:crypto')
  const { prepareImage } = await import('@/lib/upload/upload-processing')
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO upload_jobs(event_id) VALUES(1)",
  )
  const original = Buffer.from('HEVC original handled by the native decoder')
  const decoded = await sharp({
    create: { width: 600, height: 300, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer()
  state.heif.mockResolvedValueOnce({ buffer: decoded, width: 600, height: 300 })
  const publish = await prepareImage(original, 'photo.HEIC', 'heic', 'trip', 1)
  expect(state.heif).toHaveBeenCalledWith(original)
  const uploads = state.stage.mock.calls[0][0]
  expect(uploads[0].buffer).toEqual(original)
  expect(uploads[0].stagePath).toMatch(/original\.heic$/)
  expect(await sharp(uploads[1].buffer).metadata()).toMatchObject({
    format: 'jpeg',
    width: 600,
    height: 300,
  })
  expect(await sharp(uploads[2].buffer).metadata()).toMatchObject({
    format: 'jpeg',
    width: 400,
    height: 200,
  })
  await publish(1)
  const photo = (await state.db.query('SELECT * FROM photos')).rows[0]
  expect(photo.file_hash).toBe(createHash('sha256').update(original).digest('hex'))
  expect(photo.content_type).toBe('image/heic')
  expect(photo.width).toBe(600)
  expect(photo.height).toBe(300)
})

it('pages photos with stable ties, bounded payloads and filter-bound cursors', async () => {
  await state.db.exec(
    "INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'); INSERT INTO photos(event_id,source_filename,ingest_status,date_taken,exif_raw) SELECT 1,'a.jpg','READY','2026-01-01','{\"private\":\"large metadata\"}'::jsonb FROM generate_series(1,110)",
  )
  for (const sort of ['oldest', 'newest', 'name', 'uploaded']) {
    const params = new URLSearchParams({ sort, paged: 'true' })
    const first = await albumPage(params)
    expect(first.items).toHaveLength(96)
    expect(first.nextCursor).toBeTruthy()
    expect(first.items[0]).not.toHaveProperty('exifRaw')
    params.set('cursor', first.nextCursor!)
    const second = await albumPage(params)
    expect(second.items).toHaveLength(14)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map((p) => p.photoId)).size).toBe(110)
    params.set('favorite', 'true')
    await expect(albumPage(params)).rejects.toMatchObject({ status: 400 })
  }
  await expect(albumPage(new URLSearchParams('cursor=oops'))).rejects.toMatchObject({
    status: 400,
  })
})

it('returns the next two and previous neighbor with bounded photo-only preload metadata', async () => {
  const { getPhotoViewerPage, getViewerPreloadPhotos } = await import('@/lib/photos')
  await state.db
    .exec(`INSERT INTO events(sort_order,event_name,source_folder) VALUES(1,'Trip','trip'),(2,'Other','other');
    INSERT INTO photos(event_id,source_filename,ingest_status,date_taken,media_type,display_stage_path) VALUES
    (1,'a.jpg','READY','2026-01-01','photo','display/a.jpg'),
    (1,'b.jpg','READY','2026-01-02','photo','display/b.jpg'),
    (1,'c.mov','READY','2026-01-03','video','display/c.mp4'),
    (1,'d.jpg','READY','2026-01-04','photo','display/d.jpg'),
    (2,'private.jpg','READY','2026-01-05','photo','display/private.jpg');`)
  const rows = (await state.db.query('SELECT photo_id,event_id FROM photos ORDER BY photo_id')).rows
  const ids = rows.map((r: any) => r.photo_id)
  expect((await getPhotoViewerPage(ids[1], albumOwner))?.adjacent).toEqual({
    prev: ids[0],
    next: ids[2],
    next2: ids[3],
  })
  const preloads = await getViewerPreloadPhotos([ids[2], ids[3], ids[0]], [1])
  expect(preloads.map((p) => p.photo_id).sort()).toEqual([ids[0], ids[3]].sort())
  expect(await getViewerPreloadPhotos([ids[4]], [1])).toEqual([])
  expect(
    preloads.every(
      (p) => Object.keys(p).sort().join(',') === 'display_stage_path,height,photo_id,width',
    ),
  ).toBe(true)
})

it('batches 200 safe temporary objects into one scoped removal and leaves the remainder queued', async () => {
  const { cleanupStage } = await vi.importActual<typeof import('@/lib/snowflake/stage-upload')>(
    '@/lib/snowflake/stage-upload',
  )
  await state.db.exec(
    "INSERT INTO stage_cleanup(path) SELECT 'upload-chunks/expired/' || i || '.bin' FROM generate_series(1,201) i",
  )
  state.sf.mockResolvedValue([])
  await cleanupStage()
  expect(state.sf).toHaveBeenCalledOnce()
  const sql = state.sf.mock.calls[0][0] as string
  expect(sql).toMatch(/^REMOVE '@[^']+\/upload-chunks\/' PATTERN=/)
  const pattern = sql.split("PATTERN='")[1].slice(0, -1).replace(/\\\\/g, '\\').replace(/''/g, "'")
  const match = new RegExp(pattern)
  expect(match.test('upload-chunks/expired/1.bin')).toBe(true)
  expect(match.test('originals/expired/1.bin')).toBe(false)
  expect(match.test('upload-chunks/other/1.bin')).toBe(false)
  expect(match.test('upload-chunks/expired/1Xbin')).toBe(false)
  expect((await state.db.query('SELECT * FROM stage_cleanup')).rows).toHaveLength(1)
  await cleanupStage()
  expect((await state.db.query('SELECT * FROM stage_cleanup')).rows).toHaveLength(0)
  state.sf.mockClear()
  await cleanupStage()
  expect(state.sf).not.toHaveBeenCalled()
})

it('retains every cleanup intent on batch failure and backs off retries', async () => {
  const { cleanupStage } = await vi.importActual<typeof import('@/lib/snowflake/stage-upload')>(
    '@/lib/snowflake/stage-upload',
  )
  await state.db.exec(
    "INSERT INTO stage_cleanup(path) VALUES('upload-chunks/expired/a.bin'),('upload-chunks/expired/b.bin')",
  )
  state.sf.mockRejectedValue(new Error('Storage connection unexpectedly selected a warehouse'))
  await cleanupStage()
  expect(state.sf).toHaveBeenCalledOnce()
  expect(
    (
      await state.db.query(
        'SELECT attempts,last_error,next_attempt>now() AS deferred FROM stage_cleanup',
      )
    ).rows,
  ).toEqual([
    {
      attempts: 1,
      last_error: 'Storage connection unexpectedly selected a warehouse',
      deferred: true,
    },
    {
      attempts: 1,
      last_error: 'Storage connection unexpectedly selected a warehouse',
      deferred: true,
    },
  ])
  state.sf.mockClear()
  await cleanupStage()
  expect(state.sf).not.toHaveBeenCalled()
})

it('protects in-flight chunks even before their metadata exists and scopes permanent deletion', async () => {
  const { cleanupStage } = await vi.importActual<typeof import('@/lib/snowflake/stage-upload')>(
    '@/lib/snowflake/stage-upload',
  )
  await state.db.query(
    'INSERT INTO upload_sessions(upload_id,owner,total_chunks) VALUES($1,$2,1)',
    [id, 'alice'],
  )
  const active = `upload-chunks/${id}/unregistered.bin`
  await state.db.query('INSERT INTO stage_cleanup(path) VALUES($1),($2),($3)', [
    active,
    'upload-chunks/finished/a.bin',
    'originals/orphan.jpg',
  ])
  state.sf.mockResolvedValue([])
  await cleanupStage()
  expect(state.sf).toHaveBeenCalledTimes(2)
  expect(state.sf.mock.calls.every(([sql]) => !sql.includes('unregistered'))).toBe(true)
  expect(
    state.sf.mock.calls.some(([sql]) =>
      sql.startsWith("REMOVE '@PERSONAL_MEDIA.RAW.PHOTO_FILES/originals/orphan.jpg'"),
    ),
  ).toBe(true)
  expect((await state.db.query('SELECT path FROM stage_cleanup')).rows).toEqual([{ path: active }])
})
