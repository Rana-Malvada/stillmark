import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { withLocalPostgres } from './local-postgres.mjs'

await withLocalPostgres('cleanup', async ({ admin, connect, imageId }) => {
  await admin.query(`CREATE ROLE personal_photos_app; CREATE ROLE personal_photos_maintenance;
    CREATE SCHEMA photo_security; GRANT USAGE ON SCHEMA photo_security TO personal_photos_app,personal_photos_maintenance;
    CREATE TABLE stage_cleanup(path text PRIMARY KEY,next_attempt timestamptz DEFAULT now(),attempts int DEFAULT 0,last_error text);
    CREATE TABLE photos(photo_id int PRIMARY KEY,original_stage_path text,display_stage_path text,thumbnail_stage_path text);
    CREATE TABLE photo_trash(photo_id int PRIMARY KEY,photo_data jsonb);
    CREATE TABLE faces(crop_path text);
    CREATE TABLE video_playback(photo_id int,status text,stage_path text,renditions jsonb);
    CREATE TABLE upload_chunks(stage_path text);
    CREATE TABLE upload_sessions(upload_id uuid,result jsonb);
    GRANT INSERT ON photos TO personal_photos_app;
    GRANT SELECT,UPDATE,DELETE ON stage_cleanup TO personal_photos_maintenance;`)
  await admin.query('BEGIN')
  await admin.query(
    readFileSync(
      new URL('../../migrations/postgres/202610291920_stage_cleanup_claims.sql', import.meta.url),
      'utf8',
    ),
  )
  await admin.query('COMMIT')
  const publisher = await connect('personal_photos_app')
  const cleaner = await connect('personal_photos_maintenance')
  const cleaner2 = await connect('personal_photos_maintenance')
  const claim = (client, token = randomUUID()) =>
    client.query('SELECT * FROM photo_security.claim_stage_cleanup($1)', [token])
  const pid = (await cleaner.query('SELECT pg_backend_pid() pid')).rows[0].pid
  async function waitForLock() {
    for (let i = 0; i < 100; i++) {
      const r = await admin.query('SELECT cardinality(pg_blocking_pids($1)) n', [pid])
      if (r.rows[0].n > 0) return
      await delay(10)
    }
    throw Error('Cleanup did not reach the expected publication lock')
  }
  await admin.query("INSERT INTO stage_cleanup(path) VALUES('publish-first')")
  await publisher.query('BEGIN')
  await publisher.query("INSERT INTO photos VALUES(1,'publish-first',NULL,NULL)")
  const waiting = claim(cleaner).then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  await waitForLock()
  // Exercise the upload reservation path while cleanup holds a queue-row lock.
  await publisher.query("SELECT photo_security.reserve_stage_upload('publish-first')")
  await publisher.query('COMMIT')
  const published = await waiting
  if (published.error) throw published.error
  assert.deepEqual(published.value.rows, [])
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int n FROM storage_retired_paths WHERE path='publish-first'",
      )
    ).rows[0].n,
    0,
  )
  console.log('PASS publication-first race protects live media without deadlock')

  await admin.query("INSERT INTO stage_cleanup(path) VALUES('cleanup-first')")
  await cleaner.query('BEGIN')
  assert.equal((await claim(cleaner)).rows.length, 1)
  const late = publisher.query("INSERT INTO photos VALUES(2,'cleanup-first',NULL,NULL)").then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  await cleaner.query('COMMIT')
  assert.equal((await late).error?.code, '55000')
  console.log('PASS cleanup-first race rejects late publication')

  await admin.query(
    "TRUNCATE stage_cleanup; INSERT INTO stage_cleanup(path) SELECT 'orphan/'||i FROM generate_series(1,250)i",
  )
  const tokens = [randomUUID(), randomUUID()]
  const batches = await Promise.all([claim(cleaner, tokens[0]), claim(cleaner2, tokens[1])])
  const paths = batches.flatMap((r) => r.rows.map((p) => p.path))
  assert.equal(paths.length, 250)
  assert.equal(new Set(paths).size, 250)
  assert.ok(batches.every((b) => b.rows.length <= 200))
  await admin.query(
    "BEGIN; SET LOCAL lock_timeout='100ms'; SELECT * FROM stage_cleanup FOR UPDATE NOWAIT; COMMIT",
  )
  await admin.query("UPDATE stage_cleanup SET lease_until=now()-interval '1 second'")
  const replacement = randomUUID()
  const reclaimed = (await claim(cleaner2, replacement)).rows.map((p) => p.path)
  assert.equal(reclaimed.length, 200)
  assert.equal(
    (
      await cleaner.query(
        'DELETE FROM stage_cleanup WHERE path=ANY($1::text[]) AND claim_token=ANY($2::uuid[]) RETURNING path',
        [reclaimed, tokens],
      )
    ).rowCount,
    0,
  )
  console.log(
    'PASS disjoint concurrent cleanup batches, released locks and stale acknowledgment fencing',
  )
  console.log(
    JSON.stringify({
      postgres: (await admin.query('SHOW server_version')).rows[0].server_version,
      image: imageId,
      storageDeletes: 0,
      productionChanges: 0,
    }),
  )
})
