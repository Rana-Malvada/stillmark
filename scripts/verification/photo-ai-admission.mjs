/** Local correctness check, not a load test. Never accepts a remote database URL. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { withLocalPostgres } from './local-postgres.mjs'

await withLocalPostgres('admission', async ({ admin, connect, clients, imageId }) => {
  await admin.query(`CREATE ROLE personal_photos_maintenance; CREATE ROLE personal_photos_app;
    CREATE TABLE events(event_id int PRIMARY KEY,owner_username text NOT NULL);
    CREATE TABLE photos(photo_id int PRIMARY KEY,event_id int REFERENCES events,display_stage_path varchar(1024),file_hash varchar(64),
      ai_description text,ai_attempts int DEFAULT 0,ai_claim uuid,ai_lease_until timestamptz,
      ai_next_attempt_at timestamptz DEFAULT now(),ingest_status text DEFAULT 'READY',media_type text DEFAULT 'photo');
    GRANT SELECT,UPDATE ON photos TO personal_photos_maintenance; GRANT SELECT ON events TO personal_photos_maintenance;
    CREATE SCHEMA photo_security; GRANT USAGE ON SCHEMA photo_security TO personal_photos_maintenance;
    CREATE TABLE gallery_main_admins(username text PRIMARY KEY);
    CREATE TABLE gallery_access_objects(kind text,name text,marker uuid PRIMARY KEY);
    CREATE TABLE photo_security.app_roles(role_key text PRIMARY KEY,profile text);
    CREATE TABLE photo_security.app_memberships(marker uuid,role_key text,PRIMARY KEY(marker,role_key));
    INSERT INTO photo_security.app_roles VALUES('member','viewer'),('administrator','app_owner');`)
  await admin.query('BEGIN')
  await admin.query(
    readFileSync(
      new URL('../../migrations/postgres/202610292030_photo_ai_admission.sql', import.meta.url),
      'utf8',
    ),
  )
  await admin.query(
    readFileSync(
      new URL('../../migrations/postgres/202611212350_photo_ai_claim_types.sql', import.meta.url),
      'utf8',
    ),
  )
  await admin.query(
    readFileSync(
      new URL(
        '../../migrations/postgres/202611220200_photo_ai_member_hourly_limit.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  await admin.query(
    readFileSync(
      new URL(
        '../../migrations/postgres/202611220500_drop_photo_ai_member_allowance.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  await admin.query('COMMIT')
  const workers = await Promise.all(
    Array.from({ length: 8 }, () => connect('personal_photos_maintenance')),
  )
  async function reset() {
    await admin.query(`TRUNCATE photos,events,photo_ai_tenant_admission;
      UPDATE photo_ai_admission SET attempts=0,claim_sequence=0,window_start=date_trunc('hour',now(),'UTC');
      INSERT INTO events VALUES(1,'A'),(2,'B'),(3,'C');
      INSERT INTO photos(photo_id,event_id,display_stage_path,file_hash)
        SELECT n,CASE WHEN n<=10 THEN 1 WHEN n<=20 THEN 2 ELSE 3 END,'display/'||n,'hash'||n FROM generate_series(1,30)n`)
  }
  const claim = (
    client,
    fleet = 3,
    tenant = 1,
    hour = 100,
    tenantHour = 100,
    token = randomUUID(),
  ) =>
    client.query('SELECT * FROM claim_photo_ai($1,$2,$3,$4,$5)', [
      token,
      fleet,
      tenant,
      hour,
      tenantHour,
    ])
  await admin.query('BEGIN')
  await admin.query(
    readFileSync(
      new URL('../../migrations/postgres/202611131600_photo_ai_ready_poll.sql', import.meta.url),
      'utf8',
    ),
  )
  await admin.query('COMMIT')
  await admin.query(`INSERT INTO photos(photo_id, media_type, display_stage_path)
    SELECT i, 'video', 'display/'||i FROM generate_series(1,6000) i;
    ANALYZE photos`)
  const pollSql = `SELECT 1 FROM photos WHERE ai_description IS NULL AND ai_attempts<3
    AND ai_next_attempt_at<=NOW() AND (ai_lease_until IS NULL OR ai_lease_until<NOW())
    AND ingest_status='READY' AND display_stage_path IS NOT NULL AND media_type='photo' LIMIT 1`
  const plan = await workers[0].query('EXPLAIN (FORMAT JSON) ' + pollSql)
  assert.match(JSON.stringify(plan.rows), /photos_ai_ready_poll/)
  await admin.query('BEGIN')
  await admin.query("INSERT INTO photos(photo_id,display_stage_path) VALUES(6001,'display/new')")
  assert.equal((await workers[0].query(pollSql)).rowCount, 0)
  await admin.query('COMMIT')
  assert.equal((await workers[0].query(pollSql)).rowCount, 1)
  console.log('PASS indexed idle poll and cross-connection discovery on commit')

  await reset()
  const claims = (await Promise.all(workers.map((w) => claim(w)))).flatMap((result) => result.rows)
  assert.deepEqual(
    claims.map((p) => p.photo_id).sort((a, b) => a - b),
    [1, 11, 21],
  )
  for (const photo of claims) {
    assert.equal(photo.display_stage_path, `display/${photo.photo_id}`)
    assert.equal(photo.file_hash, `hash${photo.photo_id}`)
    assert.equal(photo.ai_attempts, 1)
  }
  assert.equal((await admin.query('SELECT attempts FROM photo_ai_admission')).rows[0].attempts, 3)
  // Open connections remain idle during simulated provider work: the claim has
  // committed, so another connection can acquire the admission row immediately.
  await admin.query(
    "BEGIN; SET LOCAL lock_timeout='100ms'; SELECT * FROM photo_ai_admission FOR UPDATE NOWAIT; COMMIT",
  )
  console.log('PASS concurrent claims: fleet=3, tenant=1; no admission lock after return')

  // The production profile preserves eight slots for a lone owner. Fairness is
  // achieved by rotating owners, not by cutting every owner's concurrency to one.
  await reset()
  await admin.query('UPDATE photos SET event_id=1')
  const singleOwner = (await Promise.all(workers.map((w) => claim(w, 8, 8)))).flatMap(
    (result) => result.rows,
  )
  assert.equal(singleOwner.length, 8)
  assert.equal((await claim(workers[0], 8, 8)).rows.length, 0)
  await admin.query(
    "INSERT INTO photos(photo_id,event_id,display_stage_path,file_hash) VALUES(1000,2,'display/new','new')",
  )
  await admin.query(
    "UPDATE photos SET ai_description='done',ai_claim=NULL,ai_lease_until=NULL WHERE photo_id=$1",
    [singleOwner[0].photo_id],
  )
  assert.equal((await claim(workers[0], 8, 8)).rows[0].photo_id, 1000)
  assert.equal(
    (await admin.query('SELECT count(*)::int n FROM photos WHERE ai_claim IS NOT NULL')).rows[0].n,
    8,
  )
  console.log(
    'PASS eight simultaneous slots for one owner; a new owner receives the next free slot',
  )

  // All application versions use this key, so activation cannot overlap a still
  // running legacy scheduler during a rolling release or a rollback.
  assert.equal(
    (
      await workers[0].query(
        "SELECT pg_try_advisory_lock(hashtextextended('ai-categorization',0)) locked",
      )
    ).rows[0].locked,
    true,
  )
  assert.equal(
    (
      await workers[1].query(
        "SELECT pg_try_advisory_lock(hashtextextended('ai-categorization',0)) locked",
      )
    ).rows[0].locked,
    false,
  )
  await workers[0].query("SELECT pg_advisory_unlock(hashtextextended('ai-categorization',0))")
  assert.equal(
    (
      await workers[1].query(
        "SELECT pg_try_advisory_lock(hashtextextended('ai-categorization',0)) locked",
      )
    ).rows[0].locked,
    true,
  )
  await workers[1].query("SELECT pg_advisory_unlock(hashtextextended('ai-categorization',0))")
  console.log('PASS shared scheduler lock prevents old/new worker overlap')

  await reset()
  const quota = (await Promise.all(workers.map((w) => claim(w, 8, 8, 2, 1)))).flatMap(
    (result) => result.rows,
  )
  assert.equal(quota.length, 2)
  assert.equal(new Set(quota.map((p) => Math.floor((p.photo_id - 1) / 10))).size, 2)
  console.log('PASS concurrent global/tenant hourly claim allowances')

  await reset()
  await workers[0].query('BEGIN')
  assert.equal((await claim(workers[0], 1, 1)).rows.length, 1)
  // A worker disconnect before COMMIT must roll back both the lease and quota.
  await workers[0].end()
  clients.delete(workers[0])
  const afterCrash = await claim(workers[1], 1, 1)
  assert.equal(afterCrash.rows[0].photo_id, 1)
  assert.equal((await admin.query('SELECT attempts FROM photo_ai_admission')).rows[0].attempts, 1)
  console.log('PASS disconnect before commit rolls back lease and allowance')

  const old = (await admin.query('SELECT ai_claim FROM photos WHERE photo_id=1')).rows[0].ai_claim
  await workers[1].end()
  clients.delete(workers[1])
  assert.equal((await claim(workers[3], 1, 1)).rows.length, 0)
  await admin.query(
    "UPDATE photos SET ai_lease_until=now()-interval '1 second' WHERE photo_id=1; UPDATE photos SET ingest_status='PENDING' WHERE event_id<>1",
  )
  const replacement = randomUUID()
  assert.equal((await claim(workers[3], 1, 1, 100, 100, replacement)).rows[0].photo_id, 1)
  assert.equal(
    (
      await workers[2].query(
        "UPDATE photos SET ai_description='stale' WHERE photo_id=1 AND ai_claim=$1 RETURNING photo_id",
        [old],
      )
    ).rowCount,
    0,
  )
  assert.equal(
    (
      await workers[2].query(
        "UPDATE photos SET ai_description='done',ai_claim=NULL,ai_lease_until=NULL WHERE photo_id=1 AND ai_claim=$1 RETURNING photo_id",
        [replacement],
      )
    ).rowCount,
    1,
  )
  console.log(
    'PASS committed lease survives disconnect; expired lease is reclaimed and stale publication is fenced',
  )

  const app = await connect('personal_photos_app')
  await assert.rejects(claim(app), { code: '42501' })
  console.log('PASS app role cannot claim inference work')
  console.log(
    JSON.stringify({
      postgres: (await admin.query('SHOW server_version')).rows[0].server_version,
      image: imageId,
      connections: 8,
      providerCalls: 0,
      productionChanges: 0,
    }),
  )
})
