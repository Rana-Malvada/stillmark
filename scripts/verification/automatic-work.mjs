/** Native Postgres transaction/notification checks; synthetic local data only. */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { withLocalPostgres } from './local-postgres.mjs'

const bridge = `__automaticWork_${randomUUID().replaceAll('-', '')}`
const bundled = await build({
  stdin: {
    contents:
      "export {maintainAutomaticSearch,stopAutomaticSearch} from './lib/search/automatic-search';export {recoverWorkerCycle} from './lib/worker-cycle-recovery';export {recordPreparationFailure} from './workers/video-gpu/recovery'",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'local-boundaries',
      setup(b) {
        b.onResolve({ filter: /(?:^|\/)(postgres|database-context|search-sync)$/ }, (args) => ({
          path: args.path.split('/').at(-1),
          namespace: 'local',
        }))
        b.onLoad({ filter: /.*/, namespace: 'local' }, (args) => ({
          contents:
            args.path === 'postgres'
              ? `const b=globalThis['${bridge}'];export const pgQuery=(...a)=>b.query(...a);export const pgQueryOne=async(...a)=>(await b.query(...a))[0]??null;export const pgTransaction=(f)=>b.transaction(f);export const withAdvisoryLock=(...a)=>b.lock(...a);`
              : args.path === 'database-context'
                ? 'export const withServiceDatabase=(f)=>f();'
                : `export const syncSearch=(...a)=>globalThis['${bridge}'].sync(...a);`,
        }))
      },
    },
  ],
})

await withLocalPostgres('automatic-work', async ({ admin, connect, clients, imageId }) => {
  await admin.query(`CREATE ROLE personal_photos_maintenance;CREATE ROLE personal_photos_app;
    CREATE SCHEMA photo_security;CREATE FUNCTION photo_security.flag(text) RETURNS boolean LANGUAGE SQL AS 'SELECT false';
    CREATE TABLE face_scan_queue(photo_id int PRIMARY KEY,source_path text,status text);
    CREATE TABLE video_playback(photo_id int PRIMARY KEY,original_path text,status text);
    CREATE TABLE search_enrichment(photo_id int PRIMARY KEY,source_path text,status text);
    CREATE TABLE search_queue(kind text,id bigint,revision bigint DEFAULT 1,PRIMARY KEY(kind,id));
    CREATE TABLE search_batch_runs(id uuid PRIMARY KEY);`)
  await admin.query('BEGIN')
  await admin.query(
    readFileSync(
      new URL('../../migrations/postgres/202611212200_automatic_media_work.sql', import.meta.url),
      'utf8',
    ),
  )
  await admin.query(`CREATE TABLE face_scan_runs(id uuid PRIMARY KEY,requested_by text,kind text,photo_limit int,status text,total int DEFAULT 0,created_at timestamptz DEFAULT now(),finished_at timestamptz);
    CREATE UNIQUE INDEX faces_active ON face_scan_runs((true)) WHERE status IN ('starting','running');
    CREATE TABLE video_preparation_runs(id uuid PRIMARY KEY,requested_by text,status text,total int DEFAULT 0,created_at timestamptz DEFAULT now(),finished_at timestamptz,cycle_deadline timestamptz DEFAULT now()+interval '3 hours',continued_from uuid UNIQUE);
    CREATE UNIQUE INDEX playback_active ON video_preparation_runs((true)) WHERE status IN ('starting','running');`)
  await admin.query(
    readFileSync(
      new URL('../../migrations/postgres/202611220100_worker_cycle_recovery.sql', import.meta.url),
      'utf8',
    ),
  )
  await admin.query('COMMIT')
  const listener = await connect()
  const notifications = []
  listener.on('notification', (n) => notifications.push(n))
  await listener.query('LISTEN stillmark_photo_ai_ready')
  // An ordered marker proves the listener consumed all preceding notifications.
  await listener.query('LISTEN verification_barrier')
  async function barrier() {
    const id = randomUUID()
    const received = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        listener.off('notification', onMessage)
        reject(new Error('Notification barrier timed out'))
      }, 3000)
      function onMessage(n) {
        if (n.channel === 'verification_barrier' && n.payload === id) {
          clearTimeout(timeout)
          listener.off('notification', onMessage)
          resolve()
        }
      }
      listener.on('notification', onMessage)
    })
    await admin.query("SELECT pg_notify('verification_barrier',$1)", [id])
    await received
  }
  const wakes = () => notifications.filter((n) => n.channel === 'stillmark_photo_ai_ready')
  const upload = `INSERT INTO face_scan_queue VALUES(1,'one','queued');
    INSERT INTO video_playback VALUES(2,'two','queued');
    INSERT INTO search_enrichment VALUES(1,'one','queued'),(3,'three','queued');`
  await admin.query('BEGIN')
  await admin.query(upload)
  await delay(20)
  assert.equal(wakes().length, 0, 'uncommitted upload cannot wake a worker')
  await admin.query('ROLLBACK')
  await barrier()
  assert.equal(wakes().length, 0, 'rolled-back upload cannot wake a worker')
  assert.equal((await admin.query('SELECT * FROM automatic_work_signals')).rowCount, 0)
  await admin.query('BEGIN')
  await admin.query(upload)
  await admin.query('COMMIT')
  await barrier()
  assert.equal(wakes().length, 1, 'all media kinds in one commit coalesce into one wake')
  assert.equal(wakes()[0].payload, '')
  assert.equal((await admin.query('SELECT * FROM automatic_work_signals')).rowCount, 4)
  await admin.query(
    "INSERT INTO search_queue VALUES('photo',1,1);UPDATE search_queue SET revision=2;",
  )
  await admin.query(
    "UPDATE search_enrichment SET status='running';UPDATE search_enrichment SET status='queued'",
  )
  await barrier()
  assert.equal(
    wakes().length,
    1,
    'search revisions and ordinary queued retries must not wake media workers',
  )
  await admin.query("UPDATE video_playback SET original_path='replacement'")
  await barrier()
  assert.equal(wakes().length, 2, 'replacement source wakes the media coordinator')

  const transaction = new AsyncLocalStorage()
  let beforeTransaction
  let syncCalls = 0
  let sync = async () => {
    syncCalls++
    return { remaining: 1 }
  }
  globalThis[bridge] = {
    query: async (sql, params) => (await (transaction.getStore() ?? admin).query(sql, params)).rows,
    transaction: async (fn) => {
      const before = beforeTransaction
      beforeTransaction = undefined
      if (before) await before()
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
      let held = false
      try {
        held = (
          await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) held', [name])
        ).rows[0].held
        return held ? await fn() : null
      } finally {
        if (held) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [name])
        await client.end()
        clients.delete(client)
      }
    },
    sync: (...args) => sync(...args),
  }
  const {
    maintainAutomaticSearch,
    stopAutomaticSearch,
    recoverWorkerCycle,
    recordPreparationFailure,
  } = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
  )
  process.env.AUTOMATIC_MEDIA_PROCESSING_ENABLED = 'true'
  // Hold the real coordinator after its cheap wake probe, before admission.
  // Stop commits on another physical connection before admission resumes.
  let release
  let paused
  const didPause = new Promise((resolve) => {
    paused = resolve
  })
  beforeTransaction = () =>
    new Promise((resolve) => {
      release = resolve
      paused()
    })
  const admission = maintainAutomaticSearch()
  await didPause
  assert.equal(await stopAutomaticSearch(), true)
  release()
  await admission
  assert.equal(syncCalls, 0, 'Stop must defeat a stale pending-work probe')
  assert.equal(
    (await admin.query("SELECT * FROM automatic_work_state WHERE status='running'")).rowCount,
    0,
  )
  assert.equal(
    (await admin.query('SELECT * FROM search_queue')).rowCount,
    1,
    'Stop preserves pending index work',
  )

  // A later genuine revision may run, but parallel physical coordinators must
  // share a single durable cycle and never publish concurrently.
  await admin.query('UPDATE search_queue SET revision=3')
  let releaseSync
  let started
  const didStart = new Promise((resolve) => {
    started = resolve
  })
  sync = async () => {
    syncCalls++
    started()
    await new Promise((resolve) => {
      releaseSync = resolve
    })
    return { remaining: 1 }
  }
  const first = maintainAutomaticSearch()
  await didStart
  await Promise.all(Array.from({ length: 6 }, () => maintainAutomaticSearch()))
  assert.equal(syncCalls, 1)
  const run = (await admin.query('SELECT * FROM automatic_work_state')).rows[0]
  assert.equal(run.status, 'running')
  await stopAutomaticSearch()
  releaseSync()
  await first
  assert.equal(
    (await admin.query('SELECT * FROM automatic_work_state')).rows[0].status,
    'cancelled',
  )
  await maintainAutomaticSearch()
  assert.equal(syncCalls, 1, 'late completion must not restart stopped work')
  // An interruption persists backoff, retains the original deadline, and needs no
  // new upload to finish. Stop during backoff wins on a separate connection.
  await admin.query('UPDATE search_queue SET revision=4')
  sync = async () => {
    syncCalls++
    throw new Error('provider 503')
  }
  await assert.rejects(maintainAutomaticSearch(), /provider 503/)
  const interrupted = (await admin.query('SELECT * FROM automatic_work_state')).rows[0]
  await maintainAutomaticSearch()
  assert.equal(syncCalls, 2, 'backoff does not repeatedly call provider')
  await admin.query('UPDATE automatic_work_state SET next_attempt_at=now()')
  sync = async () => {
    syncCalls++
    return { remaining: 0 }
  }
  await maintainAutomaticSearch()
  const finished = (await admin.query('SELECT * FROM automatic_work_state')).rows[0]
  assert.equal(finished.run_id, interrupted.run_id)
  assert.equal(+finished.deadline, +interrupted.deadline)
  assert.equal(finished.status, 'completed')
  await admin.query('UPDATE search_queue SET revision=5')
  sync = async () => {
    throw new Error('transport lost')
  }
  await assert.rejects(maintainAutomaticSearch(), /transport lost/)
  await stopAutomaticSearch()
  await admin.query('UPDATE automatic_work_state SET next_attempt_at=now()')
  await maintainAutomaticSearch()
  assert.equal(
    (await admin.query('SELECT status FROM automatic_work_state')).rows[0].status,
    'cancelled',
  )

  await admin.query(`ALTER TABLE face_scan_runs ADD COLUMN error text;
    ALTER TABLE video_preparation_runs ADD COLUMN error text, ADD COLUMN accepting_work boolean DEFAULT true;
    ALTER TABLE face_scan_queue ADD COLUMN run_id uuid,ADD COLUMN attempts int DEFAULT 0,ADD COLUMN claim_token uuid,ADD COLUMN lease_until timestamptz,ADD COLUMN next_attempt_at timestamptz DEFAULT now(),ADD COLUMN error text;
    ALTER TABLE video_playback ADD COLUMN preparation_run_id uuid,ADD COLUMN attempts int DEFAULT 0,ADD COLUMN claim_token uuid,ADD COLUMN lease_until timestamptz,ADD COLUMN next_attempt_at timestamptz DEFAULT now(),ADD COLUMN error text`)
  for (const kind of ['faces', 'playback']) {
    const face = kind === 'faces'
    const runs = face ? 'face_scan_runs' : 'video_preparation_runs'
    const queue = face ? 'face_scan_queue' : 'video_playback'
    const col = face ? 'run_id' : 'preparation_run_id'
    const id = randomUUID()
    await admin.query(
      `INSERT INTO ${runs}(id,requested_by,status,error,finished_at${face ? ',kind' : ''}) VALUES($1,'synthetic','attention','Worker interrupted; automatic recovery pending',now()-interval '5 minutes'${face ? ",'incremental'" : ''})`,
      [id],
    )
    await admin.query(
      `UPDATE ${queue} SET ${col}=$1,status='running',attempts=1,lease_until=now()-interval '1 minute',claim_token=gen_random_uuid()`,
      [id],
    )
    if (!face) {
      await admin.query(
        "UPDATE video_preparation_runs SET status='running',error=NULL WHERE id=$1",
        [id],
      )
      await recordPreparationFailure(
        id,
        Object.assign(new Error('transport reset'), { code: 'ECONNRESET' }),
      )
      assert.equal(
        (await admin.query('SELECT error FROM video_preparation_runs WHERE id=$1', [id])).rows[0]
          .error,
        'Worker interrupted; automatic recovery pending',
      )
      await admin.query(
        "UPDATE video_preparation_runs SET finished_at=now()-interval '5 minutes' WHERE id=$1",
        [id],
      )
    }
    const original = (await admin.query(`SELECT * FROM ${runs} WHERE id=$1`, [id])).rows[0]
    const next = await globalThis[bridge].lock('recovery-' + kind, () => recoverWorkerCycle(kind))
    assert.equal(+next.cycle_deadline, +original.cycle_deadline)
    assert.equal(next.recovery_attempts, 1)
    assert.equal(next.continued_from, id)
    assert.equal((await admin.query(`SELECT attempts FROM ${queue}`)).rows[0].attempts, 1)
    assert.equal((await admin.query(`SELECT claim_token FROM ${queue}`)).rows[0].claim_token, null)
    assert.equal(await recoverWorkerCycle(kind), null, 'only one active successor')
    await admin.query(
      `UPDATE ${runs} SET status='attention',error='Worker interrupted; automatic recovery pending',recovery_attempts=3,finished_at=now()-interval '5 minutes' WHERE id=$1`,
      [next.id],
    )
    assert.equal(await recoverWorkerCycle(kind), null, 'bounded infrastructure retries')
    await admin.query(
      `UPDATE ${runs} SET recovery_attempts=0,cycle_deadline=now()-interval '1 second' WHERE id=$1`,
      [next.id],
    )
    assert.equal(await recoverWorkerCycle(kind), null, 'original cycle is never extended')
  }
  // A crash after publishing the last photo still has durable organization work.
  const organizationId = randomUUID()
  await admin.query(
    `INSERT INTO face_scan_runs(id,requested_by,status,error,finished_at,kind,organization_pending)
    VALUES($1,'synthetic','attention','Worker interrupted; automatic recovery pending',now()-interval '5 minutes','incremental',true)`,
    [organizationId],
  )
  const organization = await recoverWorkerCycle('faces')
  assert.equal(organization.continued_from, organizationId)
  assert.equal(organization.total, 0)
  assert.equal(organization.status, 'starting')
  assert.equal(organization.organization_pending, true)
  delete globalThis[bridge]
  console.log(
    `PASS native automatic work: commit-only notification, rollback, coalescing, no search/retry wake, replacement wake, Stop/admission race, parallel publishing, late completion fencing, bounded search retries, face/playback crash recovery with original deadline and attempts, organization-only continuation (${imageId})`,
  )
})
