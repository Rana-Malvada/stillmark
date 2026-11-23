/** Local database regression comparison, not HTTP throughput or production capacity. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { withLocalPostgres } from './local-postgres.mjs'

const rounds = Number(process.env.STILLMARK_MIXED_BENCH_ROUNDS ?? 12000)
assert.ok(Number.isSafeInteger(rounds) && rounds >= 1200 && rounds <= 24000)
const read = (name) =>
  readFileSync(new URL(`../../migrations/postgres/${name}`, import.meta.url), 'utf8')
await withLocalPostgres('worker-mixed-benchmark', async ({ admin, connect, imageId }) => {
  await admin.query(`CREATE ROLE personal_photos_maintenance;CREATE ROLE personal_photos_app;
    CREATE SCHEMA photo_security;CREATE FUNCTION photo_security.flag(text) RETURNS boolean LANGUAGE SQL AS 'SELECT false';
    CREATE TABLE photos(photo_id int PRIMARY KEY, event_id int NOT NULL, display_stage_path text NOT NULL);
    INSERT INTO photos SELECT i,1,'display/'||i||'.webp' FROM generate_series(1,50000) i;
    CREATE TABLE face_scan_queue(photo_id int PRIMARY KEY,source_path text,status text);
    CREATE TABLE video_playback(photo_id int PRIMARY KEY,original_path text,status text);
    CREATE TABLE search_enrichment(photo_id int PRIMARY KEY,source_path text,status text);
    CREATE TABLE search_queue(kind text,id bigint,revision bigint DEFAULT 1,PRIMARY KEY(kind,id));
    CREATE TABLE search_batch_runs(id uuid PRIMARY KEY);
    CREATE TABLE face_scan_runs(id uuid PRIMARY KEY,status text,created_at timestamptz DEFAULT now(),finished_at timestamptz,error text);
    CREATE TABLE video_preparation_runs(id uuid PRIMARY KEY,status text,created_at timestamptz DEFAULT now(),finished_at timestamptz,error text,cycle_deadline timestamptz,continued_from uuid);
  `)
  await admin.query('BEGIN;' + read('202611212200_automatic_media_work.sql') + 'COMMIT;')
  const clients = await Promise.all(Array.from({ length: 8 }, () => connect()))
  const results = {}
  let nextId = 50000
  for (const phase of ['before', 'after']) {
    await admin.query(
      'TRUNCATE face_scan_queue,video_playback,search_enrichment,search_queue,automatic_work_signals,automatic_work_state;DELETE FROM photos WHERE photo_id>50000;',
    )
    nextId = 50000
    if (phase === 'after')
      await admin.query('BEGIN;' + read('202611220100_worker_cycle_recovery.sql') + 'COMMIT;')
    const samples = { media: [], uploadCommit: [], searchQueue: [], maintenance: [] }
    const start = performance.now()
    let pendingClients = 7
    const maintenance = (async () => {
      while (pendingClients) {
        const begin = performance.now()
        await clients[7].query(
          "SELECT run_id,status,deadline FROM automatic_work_state WHERE kind='search'",
        )
        if (phase === 'after')
          await clients[7].query(
            "SELECT id FROM face_scan_runs r WHERE status='attention' AND error='Worker interrupted; automatic recovery pending' AND recovery_attempts<3 AND cycle_deadline>now() AND NOT EXISTS(SELECT 1 FROM face_scan_runs c WHERE c.continued_from=r.id) ORDER BY created_at DESC LIMIT 1",
          )
        samples.maintenance.push(performance.now() - begin)
        await sleep(1000)
      }
    })()
    await Promise.all(
      clients.slice(0, 7).map(async (db, index) => {
        for (let i = 0; i < rounds; i++) {
          const begin = performance.now()
          let category
          if (index < 4) {
            category = 'media'
            const offset = ((i * 37 + index * 997) % 49000) + 1
            const found = await db.query(
              'SELECT photo_id,display_stage_path FROM photos WHERE event_id=$1 AND photo_id=ANY($2::int[])',
              [1, Array.from({ length: 48 }, (_, n) => offset + n)],
            )
            assert.equal(found.rowCount, 48)
          } else if (index < 6) {
            category = 'uploadCommit'
            const id = ++nextId
            await db.query('BEGIN')
            await db.query('INSERT INTO photos VALUES($1,1,$2)', [id, `display/${id}.webp`])
            await db.query("INSERT INTO face_scan_queue VALUES($1,$2,'queued');", [
              id,
              `originals/${id}`,
            ])
            await db.query("INSERT INTO search_enrichment VALUES($1,$2,'queued');", [
              id,
              `originals/${id}`,
            ])
            await db.query('COMMIT')
          } else if (index === 6) {
            category = 'searchQueue'
            await db.query(
              "INSERT INTO search_queue VALUES('photo',$1,1) ON CONFLICT(kind,id) DO UPDATE SET revision=search_queue.revision+1",
              [i + 1],
            )
          }
          if (i >= 200) samples[category].push(performance.now() - begin)
        }
        pendingClients--
      }),
    )
    await maintenance
    results[phase] = {
      elapsedMs: performance.now() - start,
      operations: rounds * 7 + samples.maintenance.length,
    }
    for (const [category, values] of Object.entries(samples)) {
      values.sort((a, b) => a - b)
      results[phase][category] = {
        count: values.length,
        p50Ms: values[Math.floor(values.length * 0.5)],
        p95Ms: values[Math.floor(values.length * 0.95)],
        p99Ms: values[Math.floor(values.length * 0.99)],
      }
    }
  }
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM photos')).rows[0].n,
    50000 + rounds * 2,
  )
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM face_scan_queue')).rows[0].n,
    rounds * 2,
  )
  console.log(
    JSON.stringify(
      {
        scope:
          'Synthetic local database only: 8 physical clients; media metadata batches, upload commits, search queue writes, maintenance checked once per second (faster than production recovery cadence). Does not measure HTTP, object storage, decoding, or production capacity.',
        imageId,
        results,
      },
      null,
      2,
    ),
  )
})
