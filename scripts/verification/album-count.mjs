/** Synthetic local PostgreSQL comparison. No remote URLs, credentials, or media. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { withLocalPostgres } from './local-postgres.mjs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
// Preserve the pre-optimization statement so subsequent runs remain comparable.
const fullCount = `UPDATE events SET photo_count=(SELECT count(*) FROM photos
 WHERE event_id=$1 AND ingest_status='READY'),updated_at=now() WHERE event_id=$1`
// Exercise the application's exact statement, including its legacy NULL fallback.
const publishedDelta = read('../../lib/albums/events.ts').match(
  /export const publishedPhotoCountSql = `([\s\S]*?)`/,
)?.[1]
assert.ok(publishedDelta, 'Publication count statement must remain available to this check')
const shared = "SELECT pg_advisory_xact_lock_shared(hashtextextended('photo-management',0))"
const insert = `INSERT INTO photos(photo_id,event_id,source_filename,file_hash,media_type,ingest_status)
 VALUES($1,$2,'synthetic.jpg',$3,'photo','READY')`
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)),
    p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3)),
  }
}
const startedAt = performance.now()

await withLocalPostgres('album-count', async ({ admin, connect, imageId }) => {
  await admin.query(`CREATE ROLE snowflake_admin; CREATE ROLE personal_photos_app NOINHERIT;
    CREATE ROLE personal_photos_reader; CREATE ROLE personal_photos_video_worker;
    CREATE ROLE personal_photos_maintenance; CREATE ROLE personal_photos_search_worker`)
  await admin.query(read('../../tests/fixtures/rls-schema.sql'))
  await admin.query('SET search_path=public')
  // pg_dump fixture omits grants; restore the catalog login grants before RLS.
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO personal_photos_app;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO personal_photos_app`)
  await admin.query(read('../../setup/72-app-rls.sql'))
  await admin.query('BEGIN')
  await admin.query(read('../../migrations/postgres/202610311200_gallery_statistics.sql'))
  await admin.query('COMMIT')
  // The schema fixture contains disabled session timeouts. Restore a finite setup budget.
  await admin.query("SET statement_timeout='120s'; SET lock_timeout='5s'")
  await admin.query(`INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username)
    VALUES(1,1,'Synthetic album','synthetic','ALICE'),(2,2,'Second album','second','ALICE')`)
  const writer = await connect('personal_photos_app')
  const contender = await connect('personal_photos_app')
  for (const client of [writer, contender]) {
    await client.query(
      "SELECT set_config('photos.username','ALICE',false),set_config('photos.can_write','true',false)",
    )
    await client.query("SET lock_timeout='5s'")
  }
  const measurements = []
  const plans = []
  let seeded = 0
  for (const size of [100, 1000, 10000, 50000]) {
    for (let first = seeded + 1; first <= size; first += 1000) {
      await admin.query(
        `INSERT INTO photos(photo_id,event_id,source_filename,file_hash,media_type,ingest_status)
        SELECT i,1,'photo-'||i||'.jpg','seed-'||i,'photo','READY' FROM generate_series($1::int,$2::int) i`,
        [first, Math.min(first + 999, size)],
      )
    }
    seeded = size
    await admin.query(fullCount, [1])
    await admin.query('VACUUM (ANALYZE) photos')
    for (const [mode, statement, args] of [
      ['fullCount', fullCount, [1]],
      ['publishedDelta', publishedDelta, [1, 1]],
    ]) {
      await writer.query('BEGIN')
      const plan = (await writer.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + statement, args))
        .rows[0]['QUERY PLAN'][0]
      await writer.query('ROLLBACK')
      const scans = []
      const visit = (node) => {
        if (node['Relation Name'] === 'photos')
          scans.push({
            type: node['Node Type'],
            index: node['Index Name'],
            rows: node['Actual Rows'],
            loops: node['Actual Loops'],
            sharedHitBlocks: node['Shared Hit Blocks'],
            sharedReadBlocks: node['Shared Read Blocks'],
          })
        for (const child of node.Plans ?? []) visit(child)
      }
      visit(plan.Plan)
      if (mode === 'publishedDelta') {
        assert.ok(
          scans.every((scan) => scan.loops === 0 || scan.rows <= 1),
          'Normal publication must not scan the album',
        )
        if (size >= 1000)
          assert.ok(
            scans.some((scan) => scan.loops > 0 && scan.index === 'photos_pkey'),
            JSON.stringify(scans),
          )
      }
      plans.push({ albumSize: size, mode, executionMs: plan['Execution Time'], photoScans: scans })
    }
    for (const mode of ['fullCount', 'publishedDelta']) {
      for (const outcome of ['insert', 'duplicate']) {
        const countMs = []
        const lockHeldMs = []
        const contenderWaitMs = []
        for (let round = 0; round < 15; round++) {
          await writer.query('BEGIN')
          await writer.query(shared)
          await writer.query('SELECT pg_advisory_xact_lock($1)', [1])
          const lockedAt = performance.now()
          await contender.query('BEGIN')
          const waitingAt = performance.now()
          const waiting = contender.query('SELECT pg_advisory_xact_lock($1)', [1]).then(
            () => ({ elapsed: performance.now() - waitingAt }),
            (error) => ({ error }),
          )
          const job = (
            await writer.query(`INSERT INTO upload_jobs(event_id,source_folder,file_count,status)
            VALUES(1,'synthetic',1,'IN_PROGRESS') RETURNING upload_job_id`)
          ).rows[0].upload_job_id
          if (outcome === 'insert') await writer.query(insert, [100001, 1, 'publication'])
          else
            assert.equal(
              (
                await writer.query(
                  'SELECT photo_id FROM photos WHERE event_id=1 AND file_hash=$1',
                  ['seed-1'],
                )
              ).rowCount,
              1,
            )
          const countStarted = performance.now()
          if (mode === 'fullCount') await writer.query(fullCount, [1])
          else if (outcome === 'insert') await writer.query(publishedDelta, [1, 100001])
          const counted = performance.now() - countStarted
          await writer.query(
            "UPDATE upload_jobs SET status='COMPLETED',completed_at=now() WHERE upload_job_id=$1",
            [job],
          )
          await writer.query('ROLLBACK')
          const held = performance.now() - lockedAt
          const waited = await waiting
          if (waited.error) throw waited.error
          await contender.query('ROLLBACK')
          if (round >= 5) {
            countMs.push(counted)
            lockHeldMs.push(held)
            contenderWaitMs.push(waited.elapsed)
          }
        }
        measurements.push({
          albumSize: size,
          mode,
          outcome,
          samples: countMs.length,
          count: summary(countMs),
          lockHeld: summary(lockHeldMs),
          contenderWait: summary(contenderWaitMs),
        })
      }
    }
    console.log(
      JSON.stringify({
        albumSize: size,
        measurements: measurements.filter((m) => m.albumSize === size),
      }),
    )
  }
  async function reconcile() {
    const rows = (
      await admin.query(`SELECT e.event_id,e.photo_count,
      (SELECT count(*)::int FROM photos p WHERE p.event_id=e.event_id AND p.ingest_status='READY') AS expected
      FROM events e ORDER BY e.event_id`)
    ).rows
    for (const row of rows)
      assert.equal(
        row.photo_count,
        row.expected,
        `Album ${row.event_id} must match READY source rows`,
      )
  }
  const begin = async (client) => {
    await client.query('BEGIN')
    await client.query(shared)
    await client.query('SELECT pg_advisory_xact_lock($1)', [1])
  }
  const publish = async (client, id) => {
    await client.query(insert, [id, 1, `new-${id}`])
    await client.query(publishedDelta, [1, id])
  }
  const waitForBlock = async (client) => {
    for (let i = 0; i < 100; i++) {
      if (
        (await admin.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [client.processID]))
          .rows[0].n > 0
      )
        return
      await delay(10)
    }
    throw Error('Expected transaction lock was not observed')
  }
  const settle = (promise) =>
    promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
  const unwrap = async (promise) => {
    const result = await promise
    if (result.error) throw result.error
    return result.value
  }
  const checks = []
  await reconcile()
  // Concurrent publishers serialize on the existing album lock and read the
  // latest committed counter. A retry of a duplicate has no second delta.
  await Promise.all(
    [writer, contender].map(async (client, index) => {
      for (let i = 0; i < 5; i++) {
        const id = 200001 + index * 10 + i
        await begin(client)
        await publish(client, id)
        await client.query('COMMIT')
        await begin(client)
        assert.equal(
          (
            await client.query('SELECT photo_id FROM photos WHERE event_id=1 AND file_hash=$1', [
              `new-${id}`,
            ])
          ).rowCount,
          1,
        )
        await client.query('COMMIT')
      }
    }),
  )
  await reconcile()
  checks.push('concurrent publication and duplicate detection')

  await begin(writer)
  await publish(writer, 200100)
  const afterRollback = settle(
    (async () => {
      await begin(contender)
      await publish(contender, 200101)
      await contender.query('COMMIT')
    })(),
  )
  await waitForBlock(contender)
  await writer.query('ROLLBACK')
  await unwrap(afterRollback)
  assert.equal((await admin.query('SELECT photo_id FROM photos WHERE photo_id=200100')).rowCount, 0)
  await reconcile()
  checks.push('rollback releases blocked publisher without leaking a count')

  // Existing management takes the exclusive barrier. Its full reconciliation
  // sees publication if publication wins, and finishes before a later publisher.
  await begin(writer)
  await publish(writer, 200200)
  await contender.query('BEGIN')
  const managementAfter = settle(
    (async () => {
      await contender.query("SELECT pg_advisory_xact_lock(hashtextextended('photo-management',0))")
      for (const id of [1, 2]) await contender.query('SELECT pg_advisory_xact_lock($1)', [id])
      await contender.query('UPDATE photos SET event_id=2 WHERE photo_id=200200')
      for (const id of [1, 2]) await contender.query(fullCount, [id])
      await contender.query('COMMIT')
    })(),
  )
  await waitForBlock(contender)
  await writer.query('COMMIT')
  await unwrap(managementAfter)
  await reconcile()
  await contender.query('BEGIN')
  await contender.query("SELECT pg_advisory_xact_lock(hashtextextended('photo-management',0))")
  for (const id of [1, 2]) await contender.query('SELECT pg_advisory_xact_lock($1)', [id])
  const publicationAfter = settle(
    (async () => {
      await begin(writer)
      await publish(writer, 200201)
      await writer.query('COMMIT')
    })(),
  )
  await waitForBlock(writer)
  await contender.query('UPDATE photos SET event_id=1 WHERE photo_id=200200')
  for (const id of [1, 2]) await contender.query(fullCount, [id])
  await contender.query('COMMIT')
  await unwrap(publicationAfter)
  await reconcile()
  checks.push('management/publication race in both lock orders')

  await writer.query('BEGIN')
  await writer.query("SELECT pg_advisory_xact_lock(hashtextextended('photo-management',0))")
  await writer.query('SELECT pg_advisory_xact_lock($1)', [1])
  await writer.query(`INSERT INTO photo_trash(photo_id,photo_data,album_name)
    SELECT p.photo_id,to_jsonb(p),e.event_name FROM photos p JOIN events e USING(event_id) WHERE p.photo_id=200200`)
  await writer.query('DELETE FROM photos WHERE photo_id=200200')
  await writer.query(fullCount, [1])
  await writer.query('COMMIT')
  await reconcile()
  await writer.query('BEGIN')
  await writer.query("SELECT pg_advisory_xact_lock(hashtextextended('photo-management',0))")
  await writer.query('SELECT pg_advisory_xact_lock($1)', [1])
  await writer.query(`INSERT INTO photos SELECT (jsonb_populate_record(NULL::photos,photo_data)).*
    FROM photo_trash WHERE photo_id=200200`)
  await writer.query('DELETE FROM photo_trash WHERE photo_id=200200')
  await writer.query(fullCount, [1])
  await writer.query('COMMIT')
  await reconcile()
  checks.push('trash and restore preserve reconciliation')

  await admin.query('UPDATE events SET photo_count=NULL WHERE event_id=1')
  await begin(writer)
  await publish(writer, 200300)
  await writer.query('COMMIT')
  await reconcile()
  await begin(writer)
  // A READY row from another album and a missing row cannot inflate this album.
  assert.equal((await writer.query(publishedDelta, [2, 200300])).rowCount, 0)
  assert.equal((await writer.query(publishedDelta, [1, 999999])).rowCount, 0)
  await writer.query('COMMIT')
  await reconcile()
  checks.push('NULL baseline and photo/album identity checks')
  for (const [id, mediaType, status, changed] of [
    [200400, null, 'READY', 1],
    [200401, 'video', 'READY', 1],
    [200402, 'photo', 'RENDITIONS_PENDING', 0],
    [200403, 'photo', 'FAILED', 0],
  ]) {
    await begin(writer)
    await writer.query(
      `INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status)
      VALUES($1,1,'lifecycle-synthetic',$2,$3)`,
      [id, mediaType, status],
    )
    assert.equal((await writer.query(publishedDelta, [1, id])).rowCount, changed)
    await writer.query('COMMIT')
    await reconcile()
  }
  checks.push('READY video and NULL media counted; pending and failed excluded')
  await writer.query("SELECT set_config('photos.username','BOB',false)")
  assert.equal((await writer.query(publishedDelta, [1, 200300])).rowCount, 0)
  await reconcile()
  checks.push('RLS denies another owner')
  console.log('PASS local PostgreSQL album count: ' + checks.join('; '))
  console.log(
    JSON.stringify({
      postgres: (await admin.query('SHOW server_version')).rows[0].server_version,
      image: imageId,
      resources: { cpus: 1, memoryMiB: 512 },
      productionChanges: 0,
      durationSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(2)),
      checks,
      note: 'Local SQL publication slice with RLS and existing triggers; excludes media preparation, network, and full HTTP upload lifecycle.',
      measurements,
      plans,
    }),
  )
})
