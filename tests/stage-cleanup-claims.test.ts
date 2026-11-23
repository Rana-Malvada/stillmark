import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'

let db: PGlite
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`CREATE ROLE personal_photos_app; CREATE ROLE personal_photos_maintenance;
  CREATE SCHEMA photo_security; GRANT USAGE ON SCHEMA photo_security TO personal_photos_app,personal_photos_maintenance;
  CREATE TABLE stage_cleanup(path text PRIMARY KEY,next_attempt timestamptz DEFAULT now(),attempts int DEFAULT 0,last_error text);
  CREATE TABLE photos(photo_id int PRIMARY KEY,original_stage_path text,display_stage_path text,thumbnail_stage_path text);
  CREATE TABLE photo_trash(photo_id int PRIMARY KEY,photo_data jsonb);
  CREATE TABLE faces(crop_path text);
  CREATE TABLE video_playback(photo_id int,status text,stage_path text,renditions jsonb);
  CREATE TABLE upload_chunks(stage_path text);
  CREATE TABLE upload_sessions(upload_id uuid,result jsonb);`)
  await db.exec(readFileSync('migrations/postgres/202610291920_stage_cleanup_claims.sql', 'utf8'))
})
afterAll(async () => db.close())
beforeEach(async () =>
  db.exec(
    'RESET ROLE; TRUNCATE stage_cleanup,storage_retired_paths,photos,photo_trash,faces,video_playback,upload_chunks,upload_sessions',
  ),
)
const token = '11111111-1111-4111-8111-111111111111'
const next = '22222222-2222-4222-8222-222222222222'
const claim = async (t = token) =>
  (
    await db.query<{ path: string }>('SELECT * FROM photo_security.claim_stage_cleanup($1)', [t])
  ).rows.map((r) => r.path)
it('protects live originals, retained trash, face crops, renditions and active chunks', async () => {
  await db.exec(`INSERT INTO photos VALUES(1,'live',NULL,NULL);
  INSERT INTO photo_trash VALUES(2,'{"original_stage_path":"trash"}');
  INSERT INTO faces VALUES('face');
  INSERT INTO video_playback VALUES(1,'ready','video','[{"stage_path":"rendition"}]');
  INSERT INTO upload_sessions VALUES('${token}',NULL);
  INSERT INTO stage_cleanup(path) VALUES('live'),('trash'),('face'),('video'),('rendition'),('upload-chunks/${token}/0'),('orphan');`)
  expect(await claim()).toEqual(['orphan'])
  expect((await db.query('SELECT path FROM storage_retired_paths')).rows).toEqual([
    { path: 'orphan' },
  ])
  expect(
    (
      await db.query(
        "SELECT next_attempt>now() deferred FROM stage_cleanup WHERE path LIKE 'upload-chunks/%'",
      )
    ).rows,
  ).toEqual([{ deferred: true }])
})
it('fences publication and stage upload after retirement, including retries after completion', async () => {
  await db.exec("INSERT INTO stage_cleanup(path) VALUES('old')")
  expect(await claim()).toEqual(['old'])
  await expect(db.exec("INSERT INTO photos VALUES(1,'old',NULL,NULL)")).rejects.toThrow('retired')
  await expect(db.query("SELECT photo_security.reserve_stage_upload('old')")).rejects.toThrow(
    'retired',
  )
  await db.exec("DELETE FROM stage_cleanup WHERE path='old'")
  await expect(db.exec("INSERT INTO upload_chunks VALUES('old')")).rejects.toThrow('retired')
  await db.exec("INSERT INTO photos VALUES(2,'new',NULL,NULL)")
})
it('reclaims expired work and prevents an old acknowledgment from deleting its new claim', async () => {
  await db.exec("INSERT INTO stage_cleanup(path) VALUES('old')")
  expect(await claim()).toEqual(['old'])
  expect(await claim(next)).toEqual([])
  await db.exec("UPDATE stage_cleanup SET lease_until=now()-interval '1 second'")
  expect(await claim(next)).toEqual(['old'])
  await db.query('DELETE FROM stage_cleanup WHERE path=$1 AND claim_token=$2', ['old', token])
  expect((await db.query('SELECT claim_token FROM stage_cleanup')).rows).toEqual([
    { claim_token: next },
  ])
})
it('does not expose cleanup claims or tombstones to the app role', async () => {
  await db.exec('SET ROLE personal_photos_app')
  await expect(db.query('SELECT * FROM storage_retired_paths')).rejects.toThrow('permission denied')
  await expect(claim()).rejects.toThrow('permission denied')
})
