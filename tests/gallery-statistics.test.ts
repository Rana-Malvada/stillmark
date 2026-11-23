import { createTestDatabase } from './fixtures/test-database'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

vi.mock('@/lib/postgres', () => ({ pgQueryOne: vi.fn() }))
import { galleryStatisticsSql } from '@/lib/gallery-statistics'

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
      {
        sql: 'SET search_path=public;GRANT USAGE ON SCHEMA public TO personal_photos_app;GRANT SELECT ON events,photos,album_shares TO personal_photos_app;',
      },
      'setup/72-app-rls.sql',
      {
        sql: `INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES
 (1,1,'Private','a','ALICE','PRIVATE'),(2,2,'Gallery','b','BOB','GALLERY'),(3,3,'Shared','c','BOB','PRIVATE'),(4,4,'Hidden','d','BOB','PRIVATE');
 INSERT INTO album_shares(event_id,username,created_by) VALUES(3,'ALICE','BOB');
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,display_stage_path) VALUES
 (1,1,'a','photo','READY','display/a'),(2,2,'b','photo','READY','display/b'),(3,3,'c','photo','READY','display/c'),(4,4,'d','photo','READY','display/d');`,
      },
      { transaction: ['202610311200_gallery_statistics'] },
    ],
  })
}, 30000)
afterAll(async () => db?.close())
async function asUser(name: string, main = false) {
  await db.exec('SET ROLE personal_photos_app')
  await db.query(
    "SELECT set_config('photos.username',$1,false),set_config('photos.main_admin',$2,false)",
    [name, String(main)],
  )
  return (await db.query<Record<string, string>>(galleryStatisticsSql)).rows[0]
}
it('counts owned, shared and gallery albums once; revocation takes effect immediately', async () => {
  expect((await asUser('ALICE')).total_photos).toBe('3')
  await db.exec('RESET ROLE;DELETE FROM album_shares WHERE event_id=3')
  expect((await asUser('ALICE')).total_photos).toBe('2')
  expect((await asUser('OTHER')).total_photos).toBe('1')
  expect((await asUser('ADMIN', true)).total_photos).toBe('4')
  expect((await asUser('')).total_photos).toBe('0')
})
it('public capabilities cannot read private count projections', async () => {
  await asUser('')
  await db.query("SELECT set_config('photos.public_hash',$1,false)", ['a'.repeat(64)])
  expect((await db.query('SELECT * FROM gallery_statistics')).rows).toEqual([])
})
it('source edits maintain projection with existing search/album triggers', async () => {
  await db.exec(
    `RESET ROLE;UPDATE photos SET ai_attempts=3,ai_claim=gen_random_uuid() WHERE photo_id=1`,
  )
  expect((await asUser('ALICE')).photos_without_ai).toBe('2')
  await db.exec('RESET ROLE;UPDATE photos SET ai_claim=NULL WHERE photo_id=1')
  expect((await asUser('ALICE')).photos_failed).toBe('1')
  await db.exec("RESET ROLE;UPDATE photos SET ai_description='done' WHERE photo_id=1")
  expect((await asUser('ALICE')).photos_with_ai).toBe('1')
  await db.exec('RESET ROLE;DELETE FROM photos WHERE photo_id=1')
  const row = await asUser('ADMIN', true)
  expect(row.total_photos).toBe('3')
  expect(Number(row.pending_photo_removals)).toBeGreaterThan(0)
})
