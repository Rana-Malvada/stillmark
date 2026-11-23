// Who may upload, and into which album, proven by outcome: each case sends a request to the
// real upload route and then reads the database and the stand-in stage. The real
// authorization code, upload session code, image processing, database layer and row-level
// security all run. Only the process edges are replaced: the database driver, the platform
// identity headers, the Snowflake role answer and stage storage (see fixtures/route-database).
import {
  APP_ORIGIN,
  type Caller,
  callerHeaders,
  createRouteDatabase,
  DATABASE_ENV,
  snowflakeRoleRows,
} from './fixtures/route-database'
import type { PGlite } from '@electric-sql/pglite'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  headers: new Headers(),
  caller: null as Caller | null,
  /** Files written to stage storage, by path. */
  stage: new Map<string, Buffer>(),
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
    throw new Error('Stage storage is replaced in this test')
  },
}))
// Stage storage: uploads land in a map instead of the Snowflake stage.
vi.mock('@/lib/snowflake/stage-upload', () => {
  const put = async (buffer: Buffer | string, path: string) => {
    if (typeof buffer === 'string') throw new Error('Unexpected file upload by path')
    s.stage.set(path, Buffer.from(buffer))
  }
  return {
    putFileToStage: put,
    putFilesToStage: async (files: Array<{ buffer: Buffer | string; stagePath: string }>) => {
      for (const file of files) await put(file.buffer, file.stagePath)
    },
    cleanupStage: async () => {},
  }
})
import { POST as legacyUpload } from '@/app/api/upload/route'
import { DELETE as discard, GET as resume, POST as sendChunk } from '@/app/api/upload/chunk/route'
import { POST as complete } from '@/app/api/upload/complete/route'
import { POST as jobStatus } from '@/app/api/upload/status/route'
import { GET as tile } from '@/app/api/tiles/[z]/[x]/[y]/route'
import { closePool } from '@/lib/postgres'
import { claimUploadJob, processUploadJob } from '@/lib/upload/upload-processing-worker'

const ALICE: Caller = { username: 'ALICE', roles: ['viewer'] }
const BOB: Caller = { username: 'BOB', roles: ['viewer'] }
const AUDITOR: Caller = { username: 'AUDITOR', roles: ['admin_readonly'] }
const ADMIN: Caller = { username: 'ADMIN', roles: ['admin'] }
const OWNER: Caller = { username: 'OWNER', roles: ['admin'] }
function signIn(caller: Caller | null) {
  s.caller = caller
  s.headers = callerHeaders(caller)
}

const UPLOAD = '11111111-1111-4111-8111-111111111111'
let jpeg: Buffer
const rows = async (sql: string) => (await s.db.query(sql)).rows as Record<string, unknown>[]
const json = (path: string, body: object) =>
  new Request(APP_ORIGIN + path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
/** Send the whole file as one chunk, the way the browser's upload client does. */
function chunk(uploadId = UPLOAD, bytes: Buffer = jpeg) {
  const form = new FormData()
  form.set('uploadId', uploadId)
  form.set('totalChunks', '1')
  form.set('chunkIndex', '0')
  form.set('chunk', new File([new Uint8Array(bytes)], 'photo.jpg'))
  return sendChunk(new Request(APP_ORIGIN + '/api/upload/chunk', { method: 'POST', body: form }))
}
const finish = (eventId: number, uploadId = UPLOAD) =>
  complete(
    json('/api/upload/complete', {
      uploadId,
      totalChunks: 1,
      fileName: 'photo.jpg',
      folderName: 'Holiday',
      eventId,
    }),
  )
const resumeState = (uploadId = UPLOAD) =>
  resume(new Request(`${APP_ORIGIN}/api/upload/chunk?uploadId=${uploadId}`))
const discardUpload = (uploadId = UPLOAD) =>
  discard(new Request(`${APP_ORIGIN}/api/upload/chunk?uploadId=${uploadId}`, { method: 'DELETE' }))
/** Everything an upload can leave behind. */
async function footprint() {
  return {
    sessions: (await rows('SELECT 1 FROM upload_sessions')).length,
    chunks: (await rows('SELECT 1 FROM upload_chunks')).length,
    photos: (await rows('SELECT 1 FROM photos')).length,
    stored: s.stage.size,
  }
}
const NOTHING = { sessions: 0, chunks: 0, photos: 0, stored: 0 }

beforeAll(async () => {
  for (const [name, value] of Object.entries(DATABASE_ENV)) vi.stubEnv(name, value)
  // Uploads are only accepted by the dedicated upload service.
  vi.stubEnv('UPLOAD_SERVICE_ONLY', 'true')
  s.db = await createRouteDatabase()
  jpeg = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 80, b: 40 } },
  })
    .jpeg()
    .toBuffer()
}, 60_000)
afterAll(async () => {
  await closePool()
  await s.db?.close()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
beforeEach(async () => {
  signIn(null)
  s.stage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('No network request is expected')
    }),
  )
  // Album 1 is Alice's and album 2 is Bob's, both private; album 3 is shared with every
  // signed-in user. Rows are deleted, not truncated: statistics are kept by row triggers.
  await s.db
    .exec(`DELETE FROM upload_sessions;DELETE FROM upload_start_limits;DELETE FROM upload_files;DELETE FROM upload_jobs;
 DELETE FROM photos;DELETE FROM events;DELETE FROM folders;DELETE FROM search_queue;DELETE FROM stage_cleanup;DELETE FROM gallery_main_admins;
 INSERT INTO gallery_main_admins(username) VALUES('OWNER');
 INSERT INTO folders(folder_id,folder_name,owner_username) VALUES(1,'Alice','ALICE'),(2,'Bob','BOB'),(3,'Shared','OWNER');
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility,folder_id) VALUES
  (1,1,'Alice private','alice','ALICE','PRIVATE',1),(2,2,'Bob private','bob','BOB','PRIVATE',2),(3,3,'Everyone','everyone','OWNER','GALLERY',3);`)
})

it('refuses every upload route without a session and stores nothing', async () => {
  for (const response of [
    await chunk(),
    await resumeState(),
    await discardUpload(),
    await finish(1),
    await jobStatus(json('/api/upload/status', { uploadIds: [UPLOAD] })),
    await legacyUpload(),
    await tile(new Request(APP_ORIGIN + '/api/tiles/1/0/0')),
  ])
    expect(response.status).toBe(401)
  expect(await footprint()).toEqual(NOTHING)
  expect(fetch).not.toHaveBeenCalled()
})

it('lets a member upload a photo into their own album', async () => {
  signIn(ALICE)
  expect((await chunk()).status).toBe(200)
  expect(await rows('SELECT owner,total_chunks FROM upload_sessions')).toEqual([
    { owner: 'ALICE', total_chunks: 1 },
  ])
  // The transfer can be resumed by its owner, who sees which chunks arrived.
  expect(await (await resumeState()).json()).toMatchObject({ exists: true, chunks: [0] })
  const done = await finish(1)
  expect(done.status).toBe(200)
  expect(await done.json()).toMatchObject({ eventId: 1, successCount: 1, skippedCount: 0 })
  // The photo is in the catalog, measured from the real file, and its files are in storage.
  const [saved] = await rows(
    'SELECT event_id,source_filename,ingest_status,media_type,width,height,original_stage_path,display_stage_path,thumbnail_stage_path FROM photos',
  )
  expect(saved).toMatchObject({
    event_id: 1,
    source_filename: 'photo.jpg',
    ingest_status: 'READY',
    media_type: 'photo',
    width: 64,
    height: 48,
  })
  expect(s.stage.get(saved.original_stage_path as string)?.equals(jpeg)).toBe(true)
  expect(s.stage.has(saved.display_stage_path as string)).toBe(true)
  expect(s.stage.has(saved.thumbnail_stage_path as string)).toBe(true)
  expect(await rows('SELECT photo_count FROM events WHERE event_id=1')).toEqual([
    { photo_count: 1 },
  ])
  // Sending the same file to the same album again adds nothing.
  const again = '22222222-2222-4222-8222-222222222222'
  expect((await chunk(again)).status).toBe(200)
  expect(await (await finish(1, again)).json()).toMatchObject({ successCount: 0, skippedCount: 1 })
  expect((await rows('SELECT 1 FROM photos')).length).toBe(1)
})

it.each([
  ['another member’s private album', 2, 404],
  ['an album that is only shared with them', 3, 403],
])('refuses a member’s upload into %s and adds no photo', async (_name, eventId, status) => {
  signIn(ALICE)
  expect((await chunk()).status).toBe(200)
  expect((await finish(eventId)).status).toBe(status)
  expect(await rows('SELECT 1 FROM photos')).toEqual([])
  expect(await rows('SELECT photo_count FROM events ORDER BY event_id')).toEqual([
    { photo_count: 0 },
    { photo_count: 0 },
    { photo_count: 0 },
  ])
  // Only the received chunk reached storage: no original, display copy or thumbnail.
  expect([...s.stage.keys()].every((path) => path.startsWith('upload-chunks/'))).toBe(true)
})

it('keeps one member’s unfinished upload out of another member’s reach', async () => {
  signIn(BOB)
  expect((await chunk()).status).toBe(200)
  const before = await footprint()
  signIn(ALICE)
  expect(await (await resumeState()).json()).toEqual({ exists: false, chunks: [] })
  // Alice can neither add to Bob's transfer, finish it into her own album nor see its job.
  expect((await chunk(UPLOAD, Buffer.from('other bytes'))).ok).toBe(false)
  expect((await finish(1)).status).toBe(404)
  expect(
    await (await jobStatus(json('/api/upload/status', { uploadIds: [UPLOAD] }))).json(),
  ).toEqual({ jobs: [] })
  // Discarding an upload that is not hers reports success and removes nothing.
  expect((await discardUpload()).status).toBe(200)
  expect(await footprint()).toEqual(before)
  expect(await rows('SELECT owner FROM upload_sessions')).toEqual([{ owner: 'BOB' }])
  signIn(BOB)
  expect((await discardUpload()).status).toBe(200)
  expect(await rows('SELECT 1 FROM upload_sessions')).toEqual([])
})

// Row-level security hides Bob's session from Alice, so the lookup finds nothing and the
// insert collides with Bob's row. That collision must be answered as 403, not a server error.
it('answers 403 when a member sends a chunk to another member’s upload', async () => {
  signIn(BOB)
  expect((await chunk()).status).toBe(200)
  signIn(ALICE)
  expect((await chunk(UPLOAD, Buffer.from('other bytes'))).status).toBe(403)
})

it('refuses every upload route to a read-only administrator', async () => {
  signIn(ALICE)
  expect((await chunk()).status).toBe(200)
  const before = await footprint()
  signIn(AUDITOR)
  for (const response of [
    await chunk('33333333-3333-4333-8333-333333333333'),
    await resumeState(),
    await discardUpload(),
    await finish(1),
    await jobStatus(json('/api/upload/status', { uploadIds: [UPLOAD] })),
    await legacyUpload(),
  ])
    expect(response.status).toBe(403)
  expect(await footprint()).toEqual(before)
})

it('lets the main administrator, and no other administrator, upload into a member’s album', async () => {
  signIn(ADMIN)
  expect((await chunk()).status).toBe(200)
  expect((await finish(2)).status).toBe(404)
  expect(await rows('SELECT 1 FROM photos')).toEqual([])
  signIn(OWNER)
  const upload = '44444444-4444-4444-8444-444444444444'
  expect((await chunk(upload)).status).toBe(200)
  expect((await finish(2, upload)).status).toBe(200)
  expect(await rows('SELECT event_id FROM photos')).toEqual([{ event_id: 2 }])
  // The album still belongs to its member.
  expect(await rows('SELECT owner_username,photo_count FROM events WHERE event_id=2')).toEqual([
    { owner_username: 'BOB', photo_count: 1 },
  ])
})

it('with the processing queue on, queues a completed upload and never processes it in the request', async () => {
  vi.stubEnv('UPLOAD_PROCESSING_QUEUE_ENABLED', 'true')
  try {
    signIn(ALICE)
    expect((await chunk()).status).toBe(200)
    const details = {
      uploadId: UPLOAD,
      totalChunks: 1,
      fileName: 'photo.jpg',
      folderName: 'Holiday',
      eventId: 1,
    }
    // A completion that asks to be processed in the request is refused.
    expect((await complete(json('/api/upload/complete', details))).status).toBe(400)
    expect(await rows('SELECT 1 FROM upload_processing_jobs')).toEqual([])
    const queued = await complete(
      json('/api/upload/complete', { ...details, queuedProcessing: true }),
    )
    expect(queued.status).toBe(202)
    expect(await queued.json()).toEqual({ queued: true, uploadId: UPLOAD })
    expect(await rows('SELECT owner,state FROM upload_processing_jobs')).toEqual([
      { owner: 'ALICE', state: 'queued' },
    ])
    // Nothing was processed: no photo yet, and its owner alone can follow the job.
    expect(await rows('SELECT 1 FROM photos')).toEqual([])
    const status = () => jobStatus(json('/api/upload/status', { uploadIds: [UPLOAD] }))
    expect(await (await status()).json()).toMatchObject({
      jobs: [{ uploadId: UPLOAD, state: 'queued', result: null }],
    })
    signIn(BOB)
    expect(await (await status()).json()).toEqual({ jobs: [] })
    // Bob aims an upload of his own at Alice's album. Queueing does not look at the album;
    // the worker does, acting as Bob, when it processes the job.
    const other = '66666666-6666-4666-8666-666666666666'
    expect((await chunk(other)).status).toBe(200)
    expect(
      (
        await complete(
          json('/api/upload/complete', { ...details, uploadId: other, queuedProcessing: true }),
        )
      ).status,
    ).toBe(202)
    // The worker has no session of its own: it runs each job as the member who queued it.
    signIn(null)
    // A suspended upload pool claims nothing; mark it running, as its controller would.
    expect(await claimUploadJob()).toBeUndefined()
    await s.db.exec("UPDATE upload_routing SET phase='pool',enabled=true")
    for (let job = await claimUploadJob(); job; job = await claimUploadJob())
      await processUploadJob(job)
    expect(
      await rows('SELECT owner,state,error FROM upload_processing_jobs ORDER BY owner'),
    ).toEqual([
      { owner: 'ALICE', state: 'done', error: null },
      { owner: 'BOB', state: 'failed', error: 'Album not found' },
    ])
    // Only Alice's file became a photo, and it is in her album.
    expect(await rows('SELECT event_id,source_filename FROM photos')).toEqual([
      { event_id: 1, source_filename: 'photo.jpg' },
    ])
  } finally {
    vi.stubEnv('UPLOAD_PROCESSING_QUEUE_ENABLED', 'false')
    await s.db.exec(
      "DELETE FROM upload_processing_jobs;UPDATE upload_routing SET phase='suspended',enabled=false",
    )
  }
})

it('refuses upload writes sent from another site', async () => {
  signIn(ALICE)
  expect((await chunk()).status).toBe(200)
  const before = await footprint()
  s.headers.set('origin', 'https://elsewhere.example')
  for (const response of [
    await chunk('55555555-5555-4555-8555-555555555555'),
    await discardUpload(),
    await finish(1),
    await jobStatus(json('/api/upload/status', { uploadIds: [UPLOAD] })),
  ])
    expect(response.status).toBe(403)
  expect(await footprint()).toEqual(before)
})

it('retires the old single-request upload for administrators and refuses everyone else', async () => {
  for (const [caller, status] of [
    [ALICE, 403],
    [AUDITOR, 403],
    [ADMIN, 410],
    [OWNER, 410],
  ] as const) {
    signIn(caller)
    expect((await legacyUpload()).status).toBe(status)
  }
  signIn(OWNER)
  s.headers.set('origin', 'https://elsewhere.example')
  expect((await legacyUpload()).status).toBe(403)
  expect(await footprint()).toEqual(NOTHING)
})

it('serves map tiles to any signed-in caller, sending no identity to the map provider', async () => {
  const upstream = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response('tile-bytes', { status: 200, headers: { ETag: '"tile-1"' } }),
  )
  vi.stubGlobal('fetch', upstream)
  for (const caller of [ALICE, AUDITOR, OWNER]) {
    signIn(caller)
    const response = await tile(new Request(APP_ORIGIN + '/api/tiles/1/0/0'))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('tile-bytes')
  }
  expect(upstream).toHaveBeenCalledTimes(3)
  const [url, init] = upstream.mock.calls[0]
  expect(url).toBe('https://tile.openstreetmap.org/1/0/0.png')
  expect([...new Headers(init?.headers).keys()].sort()).toEqual(['referer', 'user-agent'])
  // A tile that cannot exist is refused without asking the provider.
  expect((await tile(new Request(APP_ORIGIN + '/api/tiles/1/9/9'))).status).toBe(400)
  expect(upstream).toHaveBeenCalledTimes(3)
})
