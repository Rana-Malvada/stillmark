import { createTestDatabase } from './fixtures/test-database'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { acknowledgePhotosSql, claimPhotosSql } from '@/lib/search/search-sync-ack'

let db: PGlite
beforeAll(async () => {
  db = await createTestDatabase({
    roles: [
      'snowflake_admin',
      'personal_photos_app NOINHERIT',
      'personal_photos_reader',
      'personal_photos_video_worker',
      'personal_photos_maintenance',
      'personal_photos_search_worker',
    ],
    steps: [
      { sql: 'SET search_path=public' },
      'setup/72-app-rls.sql',
      {
        sql: `INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility)
    VALUES(1,1,'Test','test','ALICE','PRIVATE');
    INSERT INTO photos(photo_id,event_id,source_filename,ingest_status,display_stage_path)
    VALUES(99,1,'legacy.jpg','READY','display/legacy');`,
      },
      { transaction: ['202610311200_gallery_statistics'] },
      { transaction: ['202611101600_cancel_unpublished_search_deletes'] },
    ],
  })
}, 30000)
afterAll(async () => db?.close())
beforeEach(async () => {
  await db.exec('BEGIN')
})
afterEach(async () => {
  await db.exec('ROLLBACK')
})
async function add(id: number, ready = true) {
  await db.query(
    `INSERT INTO photos(photo_id,event_id,source_filename,ingest_status,display_stage_path)
    VALUES($1,1,'new.jpg',$2,$3)`,
    [id, ready ? 'READY' : 'PENDING', ready ? 'display/new' : null],
  )
}
async function queue(id: number) {
  return (
    await db.query<{ id: number; revision: string; publication_attempted: boolean }>(
      "SELECT id,revision,publication_attempted FROM search_queue WHERE kind='photo' AND id=$1",
      [id],
    )
  ).rows
}
async function assertProjection() {
  const actual = (
    await db.query(`SELECT count(*) FILTER(WHERE operation='upsert')::int updates,
    count(*) FILTER(WHERE operation='remove')::int removals FROM search_queue WHERE kind='photo'`)
  ).rows
  const projected = (
    await db.query(`SELECT sum(photo_updates)::int updates,sum(photo_removals)::int removals
    FROM gallery_statistics WHERE scope='all'`)
  ).rows
  expect(projected).toEqual(actual)
}
it('cancels ready and unfinished photos deleted before the publisher picks them up', async () => {
  await add(1)
  await add(2, false)
  expect((await queue(1))[0].publication_attempted).toBe(false)
  await db.exec('DELETE FROM photos WHERE photo_id IN (1,2)')
  expect(await queue(1)).toEqual([])
  expect(await queue(2)).toEqual([])
  const claimed = await db.query<{ id: number }>(claimPhotosSql)
  expect(claimed.rows.map((r) => r.id)).not.toContain(1)
  expect(claimed.rows.map((r) => r.id)).not.toContain(2)
  await assertProjection()
})
it('retains removal when deletion races a publication, even before the first acknowledgment', async () => {
  await add(1)
  const claimed = (await db.query<{ id: number; revision: string }>(claimPhotosSql)).rows.find(
    (r) => r.id === 1,
  )!
  expect((await queue(1))[0].revision).toBe(claimed.revision)
  await db.exec('DELETE FROM photos WHERE photo_id=1')
  expect((await queue(1))[0].publication_attempted).toBe(true)
  // The remote write may have succeeded; its stale acknowledgment must not erase deletion.
  await db.query(acknowledgePhotosSql, [[1], [claimed.revision], [1]])
  expect(await queue(1)).toHaveLength(1)
  // A retry removes the remote copy and acknowledges the newer removal revision.
  const removal = (await queue(1))[0]
  await db.query(acknowledgePhotosSql, [[1], [removal.revision], []])
  expect(await queue(1)).toEqual([])
  await assertProjection()
})
it('retains cleanup after a failed or unacknowledged publication and across repeated claims', async () => {
  await add(1)
  await db.query(claimPhotosSql)
  await db.query(claimPhotosSql)
  await db.exec('DELETE FROM photos WHERE photo_id=1')
  expect((await queue(1))[0].publication_attempted).toBe(true)
  await assertProjection()
})
it('preserves previously synced photos in a mixed bulk deletion, including edits after sync', async () => {
  await add(1)
  const sent = (await db.query<{ id: number; revision: string }>(claimPhotosSql)).rows.find(
    (r) => r.id === 1,
  )!
  await db.query(acknowledgePhotosSql, [[1], [sent.revision], [1]])
  expect(await queue(1)).toEqual([])
  await db.exec("UPDATE photos SET updated_at=updated_at+interval '1 second' WHERE photo_id=1")
  expect((await queue(1))[0].publication_attempted).toBe(true)
  await add(2)
  await db.exec('DELETE FROM photos WHERE photo_id IN (1,2)')
  expect(await queue(1)).toHaveLength(1)
  expect(await queue(2)).toEqual([])
  await assertProjection()
})
it('preserves unknown legacy publication history instead of treating missing acknowledgment as proof', async () => {
  expect((await queue(99))[0].publication_attempted).toBe(true)
  await db.exec('DELETE FROM photos WHERE photo_id=99')
  expect(await queue(99)).toHaveLength(1)
  await assertProjection()
})

it('retains a published tombstone through restore and redelete before cleanup', async () => {
  await add(1)
  const sent = (await db.query<{ id: number; revision: string }>(claimPhotosSql)).rows.find(
    (r) => r.id === 1,
  )!
  await db.query(acknowledgePhotosSql, [[1], [sent.revision], [1]])
  await db.exec('DELETE FROM photos WHERE photo_id=1')
  await add(1)
  await db.exec('DELETE FROM photos WHERE photo_id=1')
  expect((await queue(1))[0].publication_attempted).toBe(true)
  await assertProjection()
})
