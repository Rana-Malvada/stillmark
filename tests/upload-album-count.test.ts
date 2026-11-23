import { createTestDatabase } from './fixtures/test-database'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  db: null as any,
  tx: null as any,
  status: 'READY',
  mediaType: 'photo' as string | null,
}))
vi.mock('@/lib/postgres', () => ({
  pgQuery: async (sql: string, values?: unknown[]) =>
    (await (state.tx ?? state.db).query(sql, values)).rows,
  pgQueryOne: async (sql: string, values?: unknown[]) =>
    (await (state.tx ?? state.db).query(sql, values)).rows[0] ?? null,
  pgTransaction: async (fn: () => Promise<unknown>) => {
    if (state.tx) return fn()
    return state.db.transaction(async (tx: any) => {
      state.tx = tx
      try {
        return await fn()
      } finally {
        state.tx = null
      }
    })
  },
}))
vi.mock('@/lib/albums/album-access', () => ({ requireAlbumAccess: vi.fn() }))
vi.mock('@/lib/albums/folders', () => ({ requireFolderWrite: vi.fn() }))
vi.mock('@/lib/upload/upload-account-authority', () => ({ requireUploadAccountAuthority: vi.fn() }))
vi.mock('@/lib/upload/upload-processing', () => {
  // Only media preparation is synthetic. Exercise the real ingest transaction,
  // event helper, schema, search/statistics triggers and management operations.
  const prepare =
    async (buffer: Buffer, filename: string, _ext: string, _folder: string, eventId: number) =>
    async () => {
      const db = state.tx ?? state.db
      const hash = buffer.toString()
      const existing = (
        await db.query('SELECT photo_id FROM photos WHERE event_id=$1 AND file_hash=$2', [
          eventId,
          hash,
        ])
      ).rows[0]
      if (existing) return { status: 'skipped', photoId: existing.photo_id, filename }
      const row = (
        await db.query(
          `INSERT INTO photos(event_id,source_filename,file_hash,ingest_status,media_type,thumbnail_stage_path)
        VALUES($1,$2,$3,$4,$5,'thumbnails/synthetic.jpg') RETURNING photo_id`,
          [eventId, filename, hash, state.status, state.mediaType],
        )
      ).rows[0]
      return { status: 'success', photoId: row.photo_id, filename }
    }
  return {
    prepareImage: prepare,
    prepareVideo: prepare,
    SUPPORTED_EXTS: new Set(['jpg', 'mov']),
    VIDEO_EXTS: new Set(['mov']),
  }
})
import { ingestUpload } from '@/lib/upload/ingest-upload'
import { updateEventPhotoCount } from '@/lib/albums/events'
import { pgTransaction } from '@/lib/postgres'
import { deletePhoto } from '@/lib/photos'
import { bulkPhotos, restorePhotos } from '@/lib/photos/photo-management'

const caller = { username: 'ALICE', role: 'viewer', mainAdmin: false } as const
const upload = (hash: string, eventId = 1) =>
  ingestUpload(
    Buffer.from(hash),
    { fileName: `${hash}.jpg`, folderName: 'Synthetic', eventId },
    undefined,
    caller,
  )
const counts = async () =>
  (await state.db.query('SELECT photo_count FROM events ORDER BY event_id')).rows.map(
    (r: any) => r.photo_count,
  )
const reconcile = async () => {
  const rows = (
    await state.db.query(`SELECT e.photo_count,(SELECT count(*)::int FROM photos p
    WHERE p.event_id=e.event_id AND p.ingest_status='READY') AS expected FROM events e`)
  ).rows
  for (const row of rows) expect(row.photo_count).toBe(row.expected)
}
beforeAll(async () => {
  state.db = await createTestDatabase({
    roles: [
      'snowflake_admin',
      'personal_photos_app',
      'personal_photos_reader',
      'personal_photos_video_worker',
      'personal_photos_maintenance',
      'personal_photos_search_worker',
    ],
    steps: [
      { sql: 'SET search_path=public' },
      'setup/72-app-rls.sql',
      { transaction: ['202610311200_gallery_statistics'] },
      {
        sql: "INSERT INTO folders(folder_id,folder_name,owner_username) VALUES(1,'Synthetic','ALICE')",
      },
    ],
  })
}, 30000)
beforeEach(async () => {
  await state.db.exec(`DELETE FROM photo_trash; DELETE FROM photos; DELETE FROM upload_files;
    DELETE FROM upload_jobs; DELETE FROM events; DELETE FROM search_queue;
    INSERT INTO events(event_id,sort_order,event_name,source_folder,folder_id,owner_username)
    VALUES(1,1,'One','one',1,'ALICE'),(2,2,'Two','two',1,'ALICE')`)
  state.status = 'READY'
  state.mediaType = 'photo'
})
afterAll(async () => {
  await state.db?.close()
})

it('publishes once and duplicate replay does not rewrite the album or enqueue it again', async () => {
  const first = await upload('same')
  expect(first.successCount).toBe(1)
  const before = (
    await state.db.query(
      "SELECT e.ctid::text AS tuple,e.photo_count,q.revision FROM events e JOIN search_queue q ON q.kind='event' AND q.id=e.event_id WHERE e.event_id=1",
    )
  ).rows[0]
  expect((await upload('same')).skippedCount).toBe(1)
  expect(
    (
      await state.db.query(
        "SELECT e.ctid::text AS tuple,e.photo_count,q.revision FROM events e JOIN search_queue q ON q.kind='event' AND q.id=e.event_id WHERE e.event_id=1",
      )
    ).rows[0],
  ).toEqual(before)
  await reconcile()
})
it('counts new READY photos, videos and legacy NULL-media rows, excluding pending/failed publication', async () => {
  await upload('photo')
  state.mediaType = 'video'
  await upload('video')
  state.mediaType = null
  await upload('unknown-media')
  state.status = 'RENDITIONS_PENDING'
  await upload('pending')
  state.status = 'FAILED'
  await upload('failed')
  expect(await counts()).toEqual([3, 0])
  await reconcile()
})
it('reconciles a legacy NULL count including the new row exactly once', async () => {
  await upload('existing')
  await state.db.exec('UPDATE events SET photo_count=NULL WHERE event_id=1')
  await upload('new')
  expect(await counts()).toEqual([2, 0])
  await reconcile()
})
it('rolls back the photo, count and job on publication failure and permits one successful retry', async () => {
  await upload('existing')
  const jobsBefore = (await state.db.query('SELECT count(*) FROM upload_jobs')).rows
  await expect(
    ingestUpload(
      Buffer.from('retry'),
      { fileName: 'retry.jpg', folderName: 'Synthetic', eventId: 1 },
      undefined,
      caller,
      (fn) =>
        pgTransaction(async () => {
          await fn()
          throw Error('response persistence failed')
        }),
    ),
  ).rejects.toThrow('response persistence failed')
  expect(await counts()).toEqual([1, 0])
  expect((await state.db.query('SELECT count(*) FROM upload_jobs')).rows).toEqual(jobsBefore)
  await upload('retry')
  await upload('retry')
  expect(await counts()).toEqual([2, 0])
  await reconcile()
})
it('keeps exact counts across move, trash and restore, with explicit reconciliation available', async () => {
  const photoId = (await upload('move')).results[0].photoId!
  await upload('stay')
  await bulkPhotos([photoId], 'move', 2)
  expect(await counts()).toEqual([1, 1])
  await upload('another', 2)
  await deletePhoto(photoId)
  expect(await counts()).toEqual([1, 1])
  await restorePhotos([photoId], 1)
  expect(await counts()).toEqual([2, 1])
  await state.db.exec('UPDATE events SET photo_count=999 WHERE event_id=1')
  await updateEventPhotoCount(1)
  await reconcile()
})
