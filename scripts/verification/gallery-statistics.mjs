import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withLocalPostgres } from './local-postgres.mjs'

const sql = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
await withLocalPostgres('gallery-statistics', async ({ admin, connect }) => {
  await admin.query(sql('./gallery-statistics-fixture.sql'))
  await admin.query('BEGIN')
  await admin.query(sql('../../migrations/postgres/202610311200_gallery_statistics.sql'))
  await admin.query('COMMIT')
  const columns = [
    'total_photos',
    'total_videos',
    'photos_with_ai',
    'photos_without_ai',
    'photos_failed',
    'in_search',
    'photo_updates',
    'album_updates',
    'photo_removals',
    'album_removals',
  ]
  async function reconcile() {
    const result = await admin.query(`WITH c AS (
      SELECT v.* FROM photos p CROSS JOIN LATERAL photo_security.stats_contribution(to_jsonb(p),'photos') v
      UNION ALL SELECT v.* FROM search_queue q CROSS JOIN LATERAL photo_security.stats_contribution(to_jsonb(q),'search_queue') v
    ), expected AS (SELECT s.scope,CASE WHEN s.scope='all' THEN 0 ELSE c.album_id END scope_id,bucket,${columns.map((k) => `sum(${k}) ${k}`).join(',')}
      FROM c CROSS JOIN (VALUES('all'),('album')) s(scope) GROUP BY 1,2,3)
    SELECT count(*)::int n FROM expected e FULL JOIN gallery_statistics g USING(scope,scope_id,bucket)
    WHERE ${columns.map((k) => `coalesce(e.${k},0)<>coalesce(g.${k},0)`).join(' OR ')}`)
    assert.equal(result.rows[0].n, 0)
  }
  await reconcile()
  await admin.query(`UPDATE photos SET ai_attempts=3,ai_claim=gen_random_uuid() WHERE photo_id<=10`)
  assert.equal(
    (
      await admin.query(
        "SELECT sum(photos_without_ai)::int n FROM gallery_statistics WHERE scope='all'",
      )
    ).rows[0].n,
    100,
  )
  await admin.query('UPDATE photos SET ai_claim=NULL WHERE photo_id<=10')
  assert.equal(
    (
      await admin.query(
        "SELECT sum(photos_failed)::int n FROM gallery_statistics WHERE scope='all'",
      )
    ).rows[0].n,
    10,
  )
  await admin.query("UPDATE photos SET ai_description='accepted',ai_claim=NULL WHERE photo_id<=5")
  await reconcile()
  await admin.query('BEGIN;UPDATE photos SET event_id=2 WHERE photo_id<=30;ROLLBACK')
  await reconcile()
  for (let i = 0; i < 60; i++) {
    const id = (i % 100) + 1
    await admin.query(
      `UPDATE photos SET event_id=$2,display_stage_path=CASE WHEN $3 THEN NULL ELSE 'display/a.jpg' END,ingest_status=CASE WHEN $4 THEN 'PENDING' ELSE 'READY' END WHERE photo_id=$1`,
      [id, (i % 2) + 1, i % 3 === 0, i % 5 === 0],
    )
    if (i % 10 === 0) await reconcile()
  }
  await reconcile()
  // Stale acknowledgments cannot clear a new revision or decrement its work count.
  const before = (
    await admin.query("SELECT revision FROM search_queue WHERE kind='photo' AND id=1")
  ).rows[0].revision
  await admin.query('UPDATE photos SET updated_at=now() WHERE photo_id=1')
  assert.equal(
    (
      await admin.query("DELETE FROM search_queue WHERE kind='photo' AND id=1 AND revision=$1", [
        before,
      ])
    ).rowCount,
    0,
  )
  await reconcile()
  await admin.query('DELETE FROM events WHERE event_id=2')
  await reconcile()
  assert.ok(
    (
      await admin.query(
        "SELECT count(*)::int n FROM search_queue WHERE stats_event_id=2 AND operation='remove'",
      )
    ).rows[0].n > 0,
  )
  await admin.query("DELETE FROM search_queue WHERE operation='remove'")
  await reconcile()
  const alice = await connect('personal_photos_app')
  await alice.query("SELECT set_config('photos.username','alice',false)")
  assert.equal(
    (await alice.query("SELECT count(*)::int n FROM gallery_statistics WHERE scope='all'")).rows[0]
      .n,
    0,
  )
  await assert.rejects(
    alice.query('UPDATE gallery_statistics SET total_photos=999'),
    /permission denied/,
  )
  await admin.query("UPDATE events SET owner_username='other' WHERE event_id=1")
  assert.equal((await alice.query('SELECT count(*)::int n FROM gallery_statistics')).rows[0].n, 0)
  await alice.query("SELECT set_config('photos.main_admin','true',false)")
  assert.ok(
    (await alice.query("SELECT count(*)::int n FROM gallery_statistics WHERE scope='all'")).rows[0]
      .n <= 32,
  )
  // Concurrent independent writers must preserve increments; retry whole transactions on deadlock.
  const writers = await Promise.all([connect(), connect(), connect(), connect()])
  await Promise.all(
    writers.map(async (c, i) => {
      for (let j = 0; j < 15; j++) {
        for (let retry = 0; ; retry++) {
          try {
            await c.query('INSERT INTO photos(photo_id,event_id) VALUES($1,1)', [
              1000 + i * 100 + j,
            ])
            break
          } catch (e) {
            if (e.code !== '40P01' || retry >= 3) throw e
          }
        }
      }
    }),
  )
  await reconcile()
  // An acknowledgment racing a new edit must never lose the new revision.
  const ackSql = sql('../../lib/search/search-sync-ack.ts').match(
    /export const acknowledgePhotosSql = `([^`]+)`/,
  )[1]
  for (let round = 0; round < 12; round++) {
    const revision = (
      await admin.query("SELECT revision FROM search_queue WHERE kind='photo' AND id=1000")
    ).rows[0].revision
    const retryWholeStatement = async (client, query, args) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await client.query(query, args)
        } catch (error) {
          if (error.code !== '40P01' || attempt >= 3) throw error
        }
      }
    }
    await Promise.all([
      retryWholeStatement(writers[0], ackSql, [[1000], [revision], [1000]]),
      retryWholeStatement(
        writers[1],
        'UPDATE photos SET updated_at=clock_timestamp() WHERE photo_id=1000',
        [],
      ),
    ])
    const queued = (
      await admin.query("SELECT revision FROM search_queue WHERE kind='photo' AND id=1000")
    ).rows[0]
    assert.ok(queued && BigInt(queued.revision) > BigInt(revision))
    await reconcile()
  }
  await admin.query('INSERT INTO photos(photo_id,event_id,search_synced_at) VALUES(9998,1,now())')
  assert.equal(
    (await admin.query('SELECT search_synced_at FROM photos WHERE photo_id=9998')).rows[0]
      .search_synced_at,
    null,
  )
  await reconcile()
  // Bookkeeping-only queue changes must not rewrite counters.
  const tupleSnapshot = async () =>
    (
      await admin.query(
        'SELECT scope,scope_id,bucket,ctid::text tuple FROM gallery_statistics ORDER BY 1,2,3',
      )
    ).rows
  const tuplesBefore = await tupleSnapshot()
  await admin.query(
    "UPDATE search_queue SET queued_at=clock_timestamp(),revision=nextval('search_revision')",
  )
  assert.deepEqual(await tupleSnapshot(), tuplesBefore)
  // Fail closed on a negative final UPSERT, including a missing counter baseline.
  await assert.rejects(
    admin.query("UPDATE gallery_statistics SET total_photos=-1 WHERE scope='all'"),
    /negative/,
  )
  await admin.query('BEGIN')
  await admin.query("DELETE FROM gallery_statistics WHERE scope='all' AND bucket=mod(9998,32)")
  await assert.rejects(admin.query('DELETE FROM photos WHERE photo_id=9998'), /negative/)
  await admin.query('ROLLBACK')
  await reconcile()
  const query = sql('../../lib/gallery-statistics.ts').split('`')[1]
  const timings = []
  for (let i = 0; i < 20; i++) {
    const started = performance.now()
    await alice.query(query)
    timings.push(performance.now() - started)
  }
  timings.sort((a, b) => a - b)
  const plan = (await alice.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + query)).rows[0][
    'QUERY PLAN'
  ][0]
  assert.ok(!JSON.stringify(plan).includes('"Relation Name":"photos"'))
  assert.ok(!JSON.stringify(plan).includes('"Relation Name":"search_queue"'))
  console.log(
    JSON.stringify({ localReadP95Ms: timings[18], planExecutionMs: plan['Execution Time'] }),
  )
  await admin.query(
    'INSERT INTO photos(photo_id,event_id) SELECT i,1 FROM generate_series(10000,19999) i',
  )
  await reconcile()
  const after = []
  for (let i = 0; i < 20; i++) {
    const started = performance.now()
    await alice.query(query)
    after.push(performance.now() - started)
  }
  after.sort((a, b) => a - b)
  console.log(
    JSON.stringify({
      after10000PhotosReadP95Ms: after[18],
      allScopeRows: (
        await alice.query("SELECT count(*)::int n FROM gallery_statistics WHERE scope='all'")
      ).rows[0].n,
    }),
  )
  // Hold each schema configuration steady so DDL invalidation is outside timing.
  // Use savepoints to roll back synthetic rows without invalidating cached plans.
  const samples = { withoutProjection: [], withProjection: [] }
  for (const enabled of [false, true, true, false]) {
    await admin.query('BEGIN')
    if (!enabled) {
      for (const table of ['photos', 'search_queue']) {
        for (const operation of ['insert', 'update', 'delete']) {
          await admin.query(`ALTER TABLE ${table} DISABLE TRIGGER statistics_${operation}`)
        }
      }
    }
    for (let round = 0; round < 60; round++) {
      await admin.query('SAVEPOINT sample')
      const start = performance.now()
      await admin.query(
        'INSERT INTO photos(photo_id,event_id) SELECT i,1 FROM generate_series(30000,30003) i',
      )
      const elapsed = performance.now() - start
      await admin.query('ROLLBACK TO SAVEPOINT sample; RELEASE SAVEPOINT sample')
      if (round >= 10) samples[enabled ? 'withProjection' : 'withoutProjection'].push(elapsed)
    }
    await admin.query('ROLLBACK')
  }
  for (const values of Object.values(samples)) values.sort((a, b) => a - b)
  console.log(
    JSON.stringify({
      fourPhotoInsertMedianMs: {
        withoutProjection: samples.withoutProjection[50],
        withProjection: samples.withProjection[50],
        overheadPercent: (samples.withProjection[50] / samples.withoutProjection[50] - 1) * 100,
      },
    }),
  )
  await reconcile()
  await assert.rejects(admin.query('TRUNCATE photos CASCADE'), /TRUNCATE would invalidate/)
  console.log(
    'PASS local PostgreSQL: baseline, committed AI states, moves, rollback, stale acknowledgments, deleted-album tombstones, RLS/revocation, concurrent writers and truncate protection',
  )
})
