/** Isolated native Postgres correctness checks. No remote database or Snowflake calls. */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { withLocalPostgres } from './local-postgres.mjs'

// Run the production coordinators and SQL against Postgres, substituting only
// connection plumbing and the external Snowflake boundary.
const bridge = `__workerCostRecovery_${randomUUID().replaceAll('-', '')}`
const bundled = await build({
  stdin: {
    contents:
      "export {reserveWorkerLaunch} from './lib/worker-launch-recovery';export {refreshCostReport,costRefreshProgress,COST_QUERIES} from './lib/costs/cost-report'",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'local-database-boundaries',
      setup(b) {
        b.onResolve({ filter: /(?:^|\/)(postgres|snowflake|database-context)$/ }, (args) => ({
          path: args.path.split('/').at(-1),
          namespace: 'local-boundary',
        }))
        b.onLoad({ filter: /.*/, namespace: 'local-boundary' }, (args) => ({
          contents:
            args.path === 'postgres'
              ? `const b=globalThis['${bridge}'];export const pgQuery=(...a)=>b.query(...a);export const pgQueryOne=async(...a)=>(await b.query(...a))[0]??null;export const pgIndependent=(...a)=>b.query(...a);export const pgTransaction=(f)=>b.transaction(f);export const withAdvisoryLock=(...a)=>b.lock(...a);`
              : args.path === 'snowflake'
                ? `export const querySnowflakeLongRunning=(...a)=>globalThis['${bridge}'].snow(...a);`
                : 'export const withServiceDatabase=(f)=>f();',
        }))
      },
    },
  ],
})

await withLocalPostgres('worker-cost-recovery', async ({ admin, connect, clients, imageId }) => {
  const transaction = new AsyncLocalStorage()
  const locks = new Map()
  let snow = async () => []
  globalThis[bridge] = {
    query: async (sql, params) => (await (transaction.getStore() ?? admin).query(sql, params)).rows,
    transaction: async (fn) => {
      if (transaction.getStore()) return fn()
      const client = await connect()
      try {
        await client.query('BEGIN')
        const result = await transaction.run(client, fn)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        await client.end()
        clients.delete(client)
      }
    },
    lock: async (name, fn) => {
      const client = await connect()
      client.on('error', () => {}) // A killed owner is intentional in this test.
      let held = false
      try {
        held = (
          await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked', [name])
        ).rows[0].locked
        if (!held) return null
        locks.set(name, client)
        return await fn()
      } finally {
        if (locks.get(name) === client) locks.delete(name)
        if (held)
          await client
            .query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [name])
            .catch(() => {})
        await client.end()
        clients.delete(client)
      }
    },
    snow: (...args) => snow(...args),
  }
  const { reserveWorkerLaunch, refreshCostReport, costRefreshProgress, COST_QUERIES } =
    await import(
      `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
    )
  await admin.query(`CREATE TABLE face_scan_runs(id uuid PRIMARY KEY,status text,created_at timestamptz DEFAULT now());
    CREATE TABLE video_preparation_runs(LIKE face_scan_runs INCLUDING ALL);
    CREATE TABLE face_scan_queue(photo_id int PRIMARY KEY,run_id uuid,status text);
    CREATE TABLE video_playback(photo_id int PRIMARY KEY,preparation_run_id uuid,status text);
    CREATE ROLE personal_photos_face_worker;CREATE ROLE personal_photos_video_worker;CREATE ROLE personal_photos_maintenance;
    CREATE SCHEMA photo_security;
    CREATE TABLE app_reports(name text PRIMARY KEY,payload jsonb,refreshed_at timestamptz,attempted_at timestamptz DEFAULT now());
    CREATE TABLE cost_ai_history(query_id text,function_name text,kind text);
    CREATE TABLE cost_work(id text PRIMARY KEY,category text);
    CREATE TABLE cost_rest_requests(id text,provider_request_id text,work_id text,model text,estimated_credits numeric,status text,pricing_version text,usage jsonb,created_at timestamptz)`)
  await admin.query('BEGIN')
  await admin.query(
    readFileSync(
      new URL('../../migrations/postgres/202611212100_worker_launch_recovery.sql', import.meta.url),
      'utf8',
    ),
  )
  await admin.query('COMMIT')
  await admin.query('BEGIN')
  await admin.query(
    readFileSync(
      new URL('../../migrations/postgres/202611212300_worker_warm_idle.sql', import.meta.url),
      'utf8',
    ),
  )
  await admin.query('COMMIT')

  for (const table of ['face_scan_runs', 'video_preparation_runs']) {
    const id = randomUUID()
    await admin.query(`INSERT INTO ${table}(id,status) VALUES($1,'starting')`, [id])
    const created = (await admin.query(`SELECT created_at FROM ${table} WHERE id=$1`, [id])).rows[0]
      .created_at
    // Separate physical sessions race on the production reservation SQL. Exactly
    // one may contact START even if a coordinator loses its advisory connection.
    const contenders = await Promise.all(Array.from({ length: 8 }, () => connect()))
    const wins = await Promise.all(
      contenders.map((c) => transaction.run(c, () => reserveWorkerLaunch(table, id))),
    )
    assert.equal(wins.filter(Boolean).length, 1)
    assert.equal(await reserveWorkerLaunch(table, id), false)
    await admin.query(`UPDATE ${table} SET next_launch_at=now() WHERE id=$1`, [id])
    assert.equal(await reserveWorkerLaunch(table, id), true)
    const row = (await admin.query(`SELECT * FROM ${table} WHERE id=$1`, [id])).rows[0]
    assert.equal(row.launch_attempts, 2)
    assert.equal(row.created_at.getTime(), created.getTime())
    assert.ok(row.next_launch_at.getTime() - Date.now() > 25000)
    await admin.query(`UPDATE ${table} SET status='cancelled',next_launch_at=now() WHERE id=$1`, [
      id,
    ])
    assert.equal(await reserveWorkerLaunch(table, id), false)
    await admin.query(
      `UPDATE ${table} SET status='starting',created_at=now()-interval '31 minutes' WHERE id=$1`,
      [id],
    )
    assert.equal(await reserveWorkerLaunch(table, id), false)
  }
  console.log(
    'PASS face/video concurrent launch reservations, durable backoff, cancellation, original deadline',
  )

  for (const [kind, runs, queue, runColumn, role] of [
    ['faces', 'face_scan_runs', 'face_scan_queue', 'run_id', 'personal_photos_face_worker'],
    [
      'playback',
      'video_preparation_runs',
      'video_playback',
      'preparation_run_id',
      'personal_photos_video_worker',
    ],
  ]) {
    await admin.query(
      `GRANT USAGE ON SCHEMA photo_security TO ${role};GRANT SELECT,UPDATE ON ${runs} TO ${role};GRANT SELECT ON ${queue} TO ${role}`,
    )
    const worker = await connect(role)
    const admission = await connect()
    const id = randomUUID()
    await admin.query(`INSERT INTO ${runs}(id,status) VALUES($1,'running')`, [id])
    const idle = async () =>
      (await worker.query('SELECT photo_security.worker_idle($1,$2) state', [kind, id])).rows[0]
        .state
    assert.equal(await idle(), 'idle')
    await admin.query(`UPDATE ${runs} SET idle_since=now()-interval '14 minutes' WHERE id=$1`, [id])
    assert.equal(await idle(), 'idle')
    // New work and the expiry decision serialize on the same run row.
    await admission.query('BEGIN')
    await admission.query(`SELECT id FROM ${runs} WHERE id=$1 FOR UPDATE`, [id])
    const racingExpiry = idle()
    await admission.query(
      `INSERT INTO ${queue}(photo_id,${runColumn},status) VALUES(1,$1,'running')`,
      [id],
    )
    await admission.query(`UPDATE ${runs} SET idle_since=NULL WHERE id=$1`, [id])
    await admission.query('COMMIT')
    assert.equal(await racingExpiry, 'work')
    await admin.query(`UPDATE ${runs} SET idle_since=now()-interval '16 minutes' WHERE id=$1`, [id])
    assert.equal(await idle(), 'work') // Active processing must never be idle-stopped.
    await admin.query(`UPDATE ${queue} SET status='done' WHERE photo_id=1`)
    assert.equal(await idle(), 'idle')
    const reset = (await admin.query(`SELECT idle_since FROM ${runs} WHERE id=$1`, [id])).rows[0]
      .idle_since
    assert.ok(Date.now() - reset.getTime() < 5000)
    await admin.query(`UPDATE ${runs} SET idle_since=now()-interval '16 minutes' WHERE id=$1`, [id])
    assert.equal(await idle(), 'closed')
    assert.equal(
      (
        await admission.query(`SELECT id FROM ${runs} WHERE id=$1 AND accepting_work FOR UPDATE`, [
          id,
        ])
      ).rowCount,
      0,
    )
  }
  console.log(
    'PASS restricted face/video idle functions: reuse, 15-minute reset, active-work protection, shutdown/admission race',
  )

  const oldPayload = {
    asOf: '2026-01-01T00:00:00.000Z',
    sections: [{ key: 'ai', rows: [{ CREDITS: 2 }] }],
  }
  await admin.query(
    "INSERT INTO app_reports(name,payload,refreshed_at) VALUES('costs',$1::jsonb,'2026-01-01')",
    [JSON.stringify(oldPayload)],
  )
  await admin.query("UPDATE app_reports SET attempted_at='2026-01-01' WHERE name='costs'")
  const deferred = () => {
    let resolve
    const promise = new Promise((r) => (resolve = r))
    return { promise, resolve }
  }
  const entered = deferred()
  const external = deferred()
  let externalCalls = 0
  snow = async () => {
    externalCalls++
    entered.resolve()
    await external.promise
    return []
  }
  const lostOwner = refreshCostReport().then(
    () => null,
    (error) => error,
  )
  await entered.promise
  // A live owner is never classified as stale merely because a provider is slow.
  assert.equal((await costRefreshProgress()).status, 'running')
  await assert.rejects(refreshCostReport(), /already running/)
  assert.equal(externalCalls, 1)
  assert.deepEqual(
    (await admin.query("SELECT payload FROM app_reports WHERE name='costs'")).rows[0].payload,
    oldPayload,
  )
  const owner = locks.get('cost-report')
  const pid = (await owner.query('SELECT pg_backend_pid() pid')).rows[0].pid
  await admin.query('SELECT pg_terminate_backend($1)', [pid])
  const interrupted = await costRefreshProgress()
  assert.equal(interrupted.status, 'interrupted')
  assert.match(interrupted.error, /previous report is unchanged/)
  assert.deepEqual(
    (await admin.query("SELECT payload FROM app_reports WHERE name='costs'")).rows[0].payload,
    oldPayload,
  )
  console.log(
    'PASS cost refresh exclusion, lost database owner detected, previous report preserved',
  )

  snow = async () => []
  // A lost owner may be retried immediately; a healthy completed refresh remains
  // subject to its ordinary cooldown. The old process cannot overwrite this one.
  const replacement = await refreshCostReport()
  assert.equal(replacement.sections.length >= COST_QUERIES.length, true)
  assert.equal((await costRefreshProgress()).status, 'completed')
  external.resolve()
  assert.match((await lostOwner).message, /no longer owns/)
  assert.deepEqual(
    (await admin.query("SELECT payload FROM app_reports WHERE name='costs'")).rows[0].payload,
    JSON.parse(JSON.stringify(replacement)),
  )
  await assert.rejects(refreshCostReport(), /Wait 15 minutes/)
  console.log(
    'PASS immediate retry, stale owner fenced, atomic publication and healthy cooldown retained',
  )
  await admin.query(`UPDATE app_reports SET attempted_at='2026-01-01' WHERE name='costs';
    CREATE FUNCTION fail_cost_publish() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      IF NEW.name='costs' AND NEW.payload IS DISTINCT FROM OLD.payload THEN RAISE EXCEPTION 'simulated publish failure'; END IF;
      RETURN NEW; END$$;
    CREATE TRIGGER fail_cost_publish BEFORE UPDATE ON app_reports FOR EACH ROW EXECUTE FUNCTION fail_cost_publish()`)
  await assert.rejects(refreshCostReport(), /simulated publish failure/)
  assert.equal((await costRefreshProgress()).status, 'failed')
  assert.deepEqual(
    (await admin.query("SELECT payload FROM app_reports WHERE name='costs'")).rows[0].payload,
    JSON.parse(JSON.stringify(replacement)),
  )
  await admin.query('DROP TRIGGER fail_cost_publish ON app_reports')
  await refreshCostReport()
  console.log(
    'PASS failed publication rolls back completion, retains previous report, permits safe retry',
  )

  // Legacy versions did not persist owner IDs/status. Reconcile an interrupted
  // record but do not reinterpret progress preceding an already published report.
  await admin.query("UPDATE app_reports SET payload=$1::jsonb WHERE name='costs-progress'", [
    JSON.stringify({ startedAt: '2099-01-01T00:00:00Z', sources: [] }),
  ])
  assert.equal((await costRefreshProgress()).status, 'interrupted')
  await admin.query("UPDATE app_reports SET payload=$1::jsonb WHERE name='costs-progress'", [
    JSON.stringify({ startedAt: '2000-01-01T00:00:00Z', sources: [] }),
  ])
  assert.equal((await costRefreshProgress()).status, undefined)
  console.log('PASS legacy progress reconciliation; native image', imageId)
  delete globalThis[bridge]
})
