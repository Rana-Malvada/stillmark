import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { withLocalPostgres } from './local-postgres.mjs'

await withLocalPostgres('travel-summaries', async ({ admin, connect, imageId }) => {
  await admin.query(`CREATE ROLE personal_photos_app;CREATE ROLE personal_photos_maintenance;CREATE ROLE personal_photos_search_worker;
    CREATE SCHEMA photo_security;
    CREATE TABLE events(event_id int PRIMARY KEY);
    CREATE TABLE photos(photo_id int PRIMARY KEY,event_id int REFERENCES events ON DELETE CASCADE,date_taken timestamptz,latitude float8,longitude float8,country text,city text,thumbnail_stage_path text);
    CREATE FUNCTION photo_security.readable_events() RETURNS SETOF int LANGUAGE sql AS $$ SELECT event_id FROM public.events $$;
    GRANT USAGE ON SCHEMA photo_security TO personal_photos_maintenance;`)
  await admin.query('BEGIN')
  await admin.query(
    readFileSync(
      new URL('../../migrations/postgres/202610292200_travel_summaries.sql', import.meta.url),
      'utf8',
    ),
  )
  await admin.query('COMMIT')
  await admin.query(
    'INSERT INTO events VALUES(1),(2),(3);INSERT INTO photos(photo_id,event_id,latitude,longitude) VALUES(1,1,10,20),(2,2,20,30),(3,3,30,40)',
  )
  const builder = await connect('personal_photos_search_worker')
  await assert.rejects(
    builder.query('SELECT photo_security.refresh_travel_summary()'),
    (error) => error.code === '42501' && /schema photo_security/.test(error.message),
  )
  await admin.query(
    readFileSync(
      new URL(
        '../../migrations/postgres/202611021100_search_worker_schema_access.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  const privileges = (
    await builder.query(`SELECT
    has_schema_privilege(current_user,'photo_security','USAGE') AS usage,
    has_schema_privilege(current_user,'photo_security','CREATE') AS create,
    has_table_privilege(current_user,'photos','SELECT') AS read_photos`)
  ).rows[0]
  assert.deepEqual(privileges, { usage: true, create: false, read_photos: false })
  console.log('PASS reproduced missing schema access; migration grants only worker schema USAGE')
  const second = await connect('personal_photos_maintenance')
  const writer = await connect()
  const rebuild = (client) => client.query('SELECT photo_security.refresh_travel_summary() id')
  const pid = (await writer.query('SELECT pg_backend_pid() id')).rows[0].id
  async function blocked() {
    for (let i = 0; i < 100; i++) {
      if ((await admin.query('SELECT cardinality(pg_blocking_pids($1)) n', [pid])).rows[0].n > 0)
        return
      await delay(10)
    }
    throw Error('Writer did not reach expected lock')
  }
  await builder.query('BEGIN')
  assert.equal((await rebuild(builder)).rows[0].id, 1)
  assert.equal((await rebuild(second)).rows[0].id, 2)
  const edit = writer.query('UPDATE photos SET latitude=15 WHERE photo_id=1').then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  await blocked()
  await builder.query('COMMIT')
  const edited = await edit
  if (edited.error) throw edited.error
  assert.equal(
    (
      await admin.query(
        'SELECT built_revision=revision fresh FROM travel_summary_state WHERE event_id=1',
      )
    ).rows[0].fresh,
    false,
  )
  assert.equal((await rebuild(builder)).rows[0].id, 1)
  assert.equal(
    (await admin.query('SELECT lat FROM travel_point_summary WHERE event_id=1')).rows[0].lat,
    15,
  )
  console.log(
    'PASS concurrent builders skip busy albums; source edits invalidate a just-built snapshot',
  )
  await builder.query('BEGIN')
  assert.equal((await rebuild(builder)).rows[0].id, 3)
  const deletion = writer.query('DELETE FROM events WHERE event_id=3').then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  await blocked()
  await builder.query('COMMIT')
  const deleted = await deletion
  if (deleted.error) throw deleted.error
  assert.equal(
    (await admin.query('SELECT count(*)::int n FROM travel_point_summary WHERE event_id=3')).rows[0]
      .n,
    0,
  )
  console.log(
    'PASS parent-first locking allows concurrent album deletion without a lock-order cycle',
  )
  await admin.query('UPDATE photos SET latitude=16 WHERE photo_id=1')
  await builder.query('BEGIN')
  assert.equal((await rebuild(builder)).rows[0].id, 1)
  await builder.query('ROLLBACK')
  assert.equal(
    (
      await admin.query(
        'SELECT built_revision=revision fresh FROM travel_summary_state WHERE event_id=1',
      )
    ).rows[0].fresh,
    false,
  )
  assert.equal(
    (await admin.query('SELECT lat FROM travel_point_summary WHERE event_id=1')).rows[0].lat,
    15,
  )
  console.log('PASS rollback retains dirty state and previous summary for safe raw-data fallback')
  console.log(
    JSON.stringify({
      postgres: (await admin.query('SHOW server_version')).rows[0].server_version,
      imageId,
    }),
  )
})
