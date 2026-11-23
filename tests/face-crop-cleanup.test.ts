import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'

let db: PGlite
const claim = '00000000-0000-4000-8000-000000000001'
const otherClaim = '00000000-0000-4000-8000-000000000002'
const crop = 'faces/00000000-0000-4000-8000-000000000003.webp'
const cleanup = '00000000-0000-4000-8000-000000000004'

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`CREATE ROLE personal_photos_app; CREATE ROLE personal_photos_maintenance;
    CREATE ROLE personal_photos_face_worker;
    CREATE SCHEMA photo_security; CREATE SCHEMA face_worker;
    REVOKE ALL ON SCHEMA face_worker FROM PUBLIC;
    GRANT USAGE ON SCHEMA photo_security TO personal_photos_app,personal_photos_maintenance;
    GRANT USAGE ON SCHEMA face_worker TO personal_photos_face_worker;
    CREATE TABLE stage_cleanup(path text PRIMARY KEY,next_attempt timestamptz DEFAULT now(),attempts int DEFAULT 0,last_error text);
    CREATE TABLE photos(photo_id int PRIMARY KEY,original_stage_path text,display_stage_path text,thumbnail_stage_path text);
    CREATE TABLE photo_trash(photo_id int PRIMARY KEY,photo_data jsonb);
    CREATE TABLE faces(crop_path text);
    CREATE TABLE video_playback(photo_id int,status text,stage_path text,renditions jsonb);
    CREATE TABLE upload_chunks(stage_path text);
    CREATE TABLE upload_sessions(upload_id uuid,result jsonb);
    CREATE TABLE face_scan_queue(photo_id int PRIMARY KEY,claim_token uuid,status text,lease_until timestamptz);
    GRANT INSERT ON faces TO personal_photos_face_worker;
    GRANT SELECT,UPDATE,DELETE ON stage_cleanup TO personal_photos_maintenance;`)
  for (const file of [
    '202610291920_stage_cleanup_claims.sql',
    '202611081500_face_crop_cleanup.sql',
  ])
    await db.exec('BEGIN;' + readFileSync('migrations/postgres/' + file, 'utf8') + 'COMMIT;')
}, 30000)
afterAll(async () => db?.close())
beforeEach(async () => {
  await db.exec(`TRUNCATE stage_cleanup,storage_retired_paths,faces,face_scan_queue;
    INSERT INTO face_scan_queue VALUES
    (1,'${claim}','running',now()+interval '5 minutes'),
    (2,'${otherClaim}','running',now()+interval '5 minutes');`)
})

async function asRole<T>(role: string, work: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN;SET LOCAL ROLE ' + role)
  try {
    const value = await work()
    await db.exec('COMMIT')
    return value
  } catch (error) {
    await db.exec('ROLLBACK')
    throw error
  }
}
const reserve = (paths: unknown = [crop], photo = 1, token = claim) =>
  asRole('personal_photos_face_worker', () =>
    db.query('SELECT face_worker.reserve_crops($1,$2,$3)', [photo, token, paths]),
  )
const clean = () =>
  asRole('personal_photos_maintenance', () =>
    db.query<{ path: string }>('SELECT * FROM photo_security.claim_stage_cleanup($1)', [cleanup]),
  )

it('reserves valid crop paths once without extending the cleanup deadline', async () => {
  await reserve([crop, crop])
  const original = (await db.query('SELECT path,next_attempt>now() AS delayed FROM stage_cleanup'))
    .rows
  expect(original).toEqual([{ path: crop, delayed: true }])
  await db.exec("UPDATE stage_cleanup SET next_attempt='2020-01-01'")
  await reserve()
  expect((await db.query('SELECT count(*)::int n FROM stage_cleanup')).rows).toEqual([{ n: 1 }])
  expect((await db.query('SELECT next_attempt<now() AS due FROM stage_cleanup')).rows).toEqual([
    { due: true },
  ])
  await reserve([])
})

it('requires the exact live photo claim and grants no application entry point', async () => {
  for (const [photo, token] of [
    [2, claim],
    [1, otherClaim],
  ] as const)
    await expect(reserve([crop], photo, token)).rejects.toThrow('stale face claim')
  await db.exec("UPDATE face_scan_queue SET lease_until=now()-interval '1 second'")
  await expect(reserve()).rejects.toThrow('stale face claim')
  await expect(
    asRole('personal_photos_app', () =>
      db.query('SELECT face_worker.reserve_crops($1,$2,$3)', [1, claim, [crop]]),
    ),
  ).rejects.toThrow(/permission denied/)
  await expect(
    asRole('personal_photos_face_worker', () => db.query('SELECT * FROM storage_retired_paths')),
  ).rejects.toThrow(/permission denied/)
  expect((await db.query('SELECT * FROM stage_cleanup')).rows).toEqual([])
})

it('rejects null, arbitrary, oversized and nested path lists before inserting anything', async () => {
  for (const paths of [
    null,
    [null],
    ['originals/a.jpg'],
    ['faces/../a.webp'],
    ['faces/a.webp'],
    [crop, 'faces/not-a-uuid.webp'],
    [[crop]],
    Array(5001).fill(crop),
  ])
    await expect(reserve(paths)).rejects.toThrow('invalid face crop paths')
  expect((await db.query('SELECT * FROM stage_cleanup')).rows).toEqual([])
})

it('retains a crop referenced by a committed publication after its acknowledgment is lost', async () => {
  await reserve()
  await asRole('personal_photos_face_worker', () =>
    db.query('INSERT INTO faces(crop_path) VALUES($1)', [crop]),
  )
  // Publication committed: its queue claim is complete even if the worker did not
  // receive the response. The cleanup reservation deliberately survives it.
  await db.exec(`UPDATE face_scan_queue SET status='done',claim_token=NULL;
    UPDATE stage_cleanup SET next_attempt=now()-interval '1 second';`)
  expect((await clean()).rows).toEqual([])
  expect((await db.query('SELECT * FROM faces')).rows).toEqual([{ crop_path: crop }])
  expect((await db.query('SELECT * FROM storage_retired_paths')).rows).toEqual([])
  expect((await db.query('SELECT * FROM stage_cleanup')).rows).toEqual([])
})

it('reclaims a failed publication once and fences late publication or reservation', async () => {
  await reserve()
  await db.exec("UPDATE stage_cleanup SET next_attempt=now()-interval '1 second'")
  expect((await clean()).rows).toEqual([{ path: crop }])
  expect((await clean()).rows).toEqual([])
  await expect(reserve()).rejects.toThrow('Storage path was retired')
  await expect(
    asRole('personal_photos_face_worker', () =>
      db.query('INSERT INTO faces(crop_path) VALUES($1)', [crop]),
    ),
  ).rejects.toThrow('Storage path was retired')
  expect((await db.query('SELECT * FROM faces')).rows).toEqual([])
})
