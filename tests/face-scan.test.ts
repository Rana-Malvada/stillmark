import { createTestDatabase } from './fixtures/test-database'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  db: null as import('@electric-sql/pglite').PGlite | null,
  inTx: false,
  role: 'personal_photos_app',
  calls: [] as [string, string][],
  job: 'NOT_FOUND',
}))
async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (state.inTx) return fn()
  const db = state.db!
  await db.exec(`BEGIN;SET LOCAL ROLE ${state.role}`)
  for (const [k, v] of Object.entries({ username: 'ADMIN', can_write: 'true', main_admin: 'true' }))
    await db.query('SELECT set_config($1,$2,true)', ['photos.' + k, v])
  state.inTx = true
  try {
    const result = await fn()
    await db.exec('COMMIT')
    return result
  } catch (error) {
    await db.exec('ROLLBACK')
    throw error
  } finally {
    state.inTx = false
  }
}
vi.mock('@/lib/postgres', () => {
  const pgQuery = (sql: string, params: unknown[] = []) =>
    tx(async () => (await state.db!.query(sql, params)).rows)
  return {
    pgQuery,
    pgQueryOne: async (sql: string, params?: unknown[]) => (await pgQuery(sql, params))[0] ?? null,
    pgTransaction: tx,
    withAdvisoryLock: async (_name: string, fn: () => Promise<unknown>) => fn(),
  }
})
vi.mock('@/lib/snowflake', () => ({
  querySnowflake: vi.fn(async (_sql: string, { binds }: { binds: [string, string] }) => {
    state.calls.push(binds)
    return [
      {
        RESULT: {
          status:
            binds[1] === 'START' ? 'PENDING' : binds[1] === 'CANCEL' ? 'CANCELLED' : state.job,
        },
      },
    ]
  }),
}))
vi.mock('@/lib/database/database-context', () => ({
  withServiceDatabase: (fn: () => unknown) => fn(),
}))
import {
  maintainFaceScan,
  scanStatus,
  startScan,
  stopScan,
  TIME_BUDGET,
} from '@/lib/people/face-scan'
import { querySnowflake } from '@/lib/snowflake'

const admin = async (sql: string) => (await state.db!.query(sql)).rows as Record<string, any>[]
const queue = () => admin('SELECT photo_id, status, run_id FROM face_scan_queue ORDER BY photo_id')

beforeAll(async () => {
  state.db = await createTestDatabase({
    extensions: true,
    roles: [
      'snowflake_admin',
      'personal_photos_app NOINHERIT',
      'personal_photos_reader',
      'personal_photos_video_worker',
      'personal_photos_maintenance',
    ],
    steps: [
      {
        sql: `SET search_path=public;GRANT USAGE ON SCHEMA public TO personal_photos_app,personal_photos_maintenance;
 GRANT SELECT,INSERT,UPDATE,DELETE ON events,photos TO personal_photos_app;
`,
      },
      'setup/72-app-rls.sql',
      '202610072000_people_faces',
      '202610072010_people_worker_queue',
      '202610290220_assertion_cleanup_schema_access',
      {
        sql: 'CREATE TABLE search_enrichment(photo_id int,status text,source_path text); CREATE TABLE search_batch_runs(id uuid)',
      },
      '202611212100_worker_launch_recovery',
      '202611212200_automatic_media_work',
      '202611212300_worker_warm_idle',
      '202611220100_worker_cycle_recovery',
    ],
  })
}, 60000)
afterAll(async () => {
  vi.unstubAllEnvs()
  await state.db?.close()
})
beforeEach(async () => {
  vi.stubEnv('AUTOMATIC_MEDIA_PROCESSING_ENABLED', 'true')
  vi.mocked(querySnowflake).mockClear()
  state.calls = []
  state.job = 'NOT_FOUND'
  state.role = 'personal_photos_app'
  await state.db!.exec(`RESET ROLE;
 TRUNCATE face_scan_queue, face_scan_runs, face_settings, photos, events RESTART IDENTITY CASCADE;
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES
  (1,1,'A','a','ALICE','PRIVATE'),(2,2,'B','b','BOB','PRIVATE');
 INSERT INTO face_settings(owner_username,enabled) VALUES('ALICE',true),('BOB',false);
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path) VALUES
  (1,1,'1.jpg','photo','READY','o/1'),(2,1,'2.jpg','photo','READY','o/2'),(3,1,'3.mov','video','READY','o/3'),
  (4,1,'4.jpg','photo','PROCESSING','o/4'),(5,2,'5.jpg','photo','READY','o/5'),(6,1,'6.jpg','photo','READY','o/6');
 -- Photo 6 was scanned already; uploads by an opted-in owner are queued without a run.
 UPDATE face_scan_queue SET status='done' WHERE photo_id=6;
 TRUNCATE automatic_work_signals;`)
})

describe('status', () => {
  it('counts only still photos of owners who turned People on', async () => {
    const status = await scanStatus()
    expect(status.summary).toEqual({ total: 3, scanned: 1, pending: 2, failed: 0, owners: 1 })
    expect(status.run).toBeNull()
    expect(status.estimatedMinutes).toBe(1)
  })
})

describe('start', () => {
  it('queues every unscanned photo into one run and launches the job once', async () => {
    const run = await startScan('ADMIN')
    expect(run).toMatchObject({
      status: 'starting',
      total: 2,
      requested_by: 'ADMIN',
      kind: 'backfill',
    })
    expect((await queue()).filter((q) => q.run_id === run.id).map((q) => q.photo_id)).toEqual([
      1, 2,
    ])
    expect(state.calls).toEqual([[run.id, 'START']])
    // Pressing again reuses the run; the deterministic job name prevents a second job.
    expect((await startScan('ADMIN')).id).toBe(run.id)
    expect(await admin('SELECT count(*)::int AS n FROM face_scan_runs')).toEqual([{ n: 1 }])
  })
  it('rescans a photo whose original was replaced, and retries failed photos', async () => {
    await state.db!.exec(`UPDATE photos SET original_stage_path='o/6b' WHERE photo_id=6;
      INSERT INTO face_scan_queue(photo_id,owner_username,source_path,status,attempts,error) VALUES(2,'ALICE','o/2','failed',3,'Boom')
      ON CONFLICT(photo_id) DO UPDATE SET status='failed',attempts=3,error='Boom'`)
    expect((await scanStatus()).summary).toMatchObject({ pending: 3, failed: 1 })
    const run = await startScan('ADMIN')
    expect(run.total).toBe(3)
    expect(
      await admin(
        `SELECT photo_id,status,attempts,source_path FROM face_scan_queue WHERE photo_id IN (2,6) ORDER BY 1`,
      ),
    ).toEqual([
      { photo_id: 2, status: 'queued', attempts: 0, source_path: 'o/2' },
      { photo_id: 6, status: 'queued', attempts: 0, source_path: 'o/6b' },
    ])
  })
  it('queues photos uploaded before People was turned on (no queue row yet)', async () => {
    // Regression: the production library had no queue rows; the running-lease filter
    // evaluated to NULL for them and excluded every photo.
    await state.db!.exec('DELETE FROM face_scan_queue WHERE photo_id IN (1,2)')
    expect((await scanStatus()).summary).toMatchObject({ pending: 2 })
    const run = await startScan('ADMIN')
    expect(run.total).toBe(2)
    expect((await queue()).filter((q) => q.run_id === run.id).map((q) => q.photo_id)).toEqual([
      1, 2,
    ])
  })
  it('does not start the CPU when nothing needs scanning', async () => {
    await state.db!.exec(`UPDATE face_scan_queue SET status='done'`)
    expect(await startScan('ADMIN')).toMatchObject({ status: 'completed', total: 0 })
    expect(state.calls).toEqual([])
  })
})

describe('continuing and recovery', () => {
  it('recovers a committed run whose coordinator vanished before START without changing its snapshot or deadline', async () => {
    const run = await startScan('ADMIN')
    const before = await queue()
    // Recreate the durable state immediately after commit, before launch reservation.
    await state.db!.exec(
      `UPDATE face_scan_runs SET launch_attempts=0,next_launch_at=now() WHERE id='${run.id}'`,
    )
    state.calls = []
    state.role = 'personal_photos_maintenance'
    await maintainFaceScan()
    expect(state.calls).toEqual([
      [run.id, 'STATUS'],
      [run.id, 'START'],
    ])
    expect(await queue()).toEqual(before)
    const saved = (await admin(`SELECT * FROM face_scan_runs WHERE id='${run.id}'`))[0]
    expect(new Date(saved.created_at).getTime()).toBe(new Date(run.created_at).getTime())
    expect(saved.launch_attempts).toBe(1)
    await maintainFaceScan()
    expect(state.calls.filter((c) => c[1] === 'START')).toHaveLength(1)
  })
  it('backs off a lost START response and never relaunches the accepted pending job', async () => {
    vi.mocked(querySnowflake).mockRejectedValueOnce(new Error('response lost'))
    await expect(startScan('ADMIN')).rejects.toThrow('Could not confirm')
    const [run] = await admin('SELECT * FROM face_scan_runs')
    expect(run.launch_attempts).toBe(1)
    state.job = 'PENDING'
    await maintainFaceScan()
    expect(state.calls).toEqual([])
    await state.db!.exec(`UPDATE face_scan_runs SET next_launch_at=now() WHERE id='${run.id}'`)
    await maintainFaceScan()
    await startScan('ADMIN')
    expect(state.calls.every((c) => c[1] === 'STATUS')).toBe(true)
    expect((await admin('SELECT launch_attempts FROM face_scan_runs'))[0].launch_attempts).toBe(1)
  })
  async function finishBatch(
    id: string,
    done: number[],
    error: string | null,
    processed = done.length,
  ) {
    await state.db!
      .exec(`UPDATE face_scan_queue SET status='done' WHERE photo_id IN (${done.join(',')});
      UPDATE face_scan_runs SET status='${error ? 'attention' : 'completed'}', processed=${processed},
        error=${error ? `'${error}'` : 'NULL'}, finished_at=now() WHERE id='${id}'`)
  }
  it('starts the next batch when a job stops at its time budget with photos left', async () => {
    const first = await startScan('ADMIN')
    await finishBatch(first.id, [1], TIME_BUDGET)
    state.role = 'personal_photos_maintenance'
    const next = await maintainFaceScan()
    expect(next).toMatchObject({ status: 'starting', total: 1, requested_by: 'ADMIN' })
    expect((await queue()).find((q) => q.photo_id === 2)!.run_id).toBe(next!.id)
    expect(state.calls.at(-1)).toEqual([next!.id, 'START'])
    // A finished scan is not continued.
    await finishBatch(next!.id, [2], null)
    expect(await maintainFaceScan()).toBeNull()
  })
  it('never loops on a batch that made no progress, or one that finished with failures', async () => {
    const run = await startScan('ADMIN')
    await finishBatch(run.id, [1], TIME_BUDGET, 0)
    expect(await maintainFaceScan()).toBeNull()
    await finishBatch(run.id, [1], '1 photo(s) could not be scanned')
    expect(await maintainFaceScan()).toBeNull()
    expect(state.calls).toEqual([[run.id, 'START']])
  })
  it('cancels a startup stuck for thirty minutes and frees the button', async () => {
    const run = await startScan('ADMIN')
    await state.db!.exec(
      `UPDATE face_scan_runs SET created_at=now()-interval '31 minutes' WHERE id='${run.id}'`,
    )
    await maintainFaceScan()
    expect(state.calls.at(-1)).toEqual([run.id, 'CANCEL'])
    expect((await admin(`SELECT status FROM face_scan_runs WHERE id='${run.id}'`))[0].status).toBe(
      'attention',
    )
    expect((await startScan('ADMIN')).id).not.toBe(run.id)
  })
  it('settles a crashed job whose heartbeat stopped', async () => {
    const run = await startScan('ADMIN')
    await state.db!.exec(
      `UPDATE face_scan_runs SET status='running', heartbeat_at=now()-interval '5 minutes' WHERE id='${run.id}'`,
    )
    state.job = 'FAILED'
    await maintainFaceScan()
    expect(
      (await admin(`SELECT status, error FROM face_scan_runs WHERE id='${run.id}'`))[0],
    ).toMatchObject({
      status: 'attention',
      error: 'Worker interrupted; automatic recovery pending',
    })
  })
})

describe('stop', () => {
  it('cancels the job, never restarts it, and a later Start picks up the rest', async () => {
    const run = await startScan('ADMIN')
    expect(await stopScan()).toEqual({ stopped: run.id })
    expect(state.calls.at(-1)).toEqual([run.id, 'CANCEL'])
    state.role = 'personal_photos_maintenance'
    expect(await maintainFaceScan()).toBeNull()
    state.role = 'personal_photos_app'
    const again = await startScan('ADMIN')
    expect(again.total).toBe(2)
    await expect(stopScan()).resolves.toBeTruthy()
    await expect(stopScan()).rejects.toMatchObject({ status: 409 })
  })
})

it('status polling does not check Snowflake or recover stale workers', async () => {
  await startScan('ADMIN')
  await state.db!.exec("UPDATE face_scan_runs SET created_at=NOW()-INTERVAL '31 minutes'")
  state.calls.length = 0
  const result = await scanStatus()
  expect(result.run?.status).toBe('starting')
  expect(state.calls).toEqual([])
})

async function uploadFace(id: number, event = 1) {
  await state.db!.query(
    `INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path)
    VALUES($1,$2,($1::int)::text||'.jpg','photo','READY','new/'||($1::int)::text)`,
    [id, event],
  )
}
it('automatically admits only new opted-in uploads and reuses the warm run', async () => {
  state.role = 'personal_photos_maintenance'
  await uploadFace(7)
  await uploadFace(8, 2)
  const run = await maintainFaceScan()
  expect(run).toMatchObject({ total: 1, kind: 'incremental', requested_by: 'automatic-upload' })
  expect((await queue()).filter((q) => q.run_id === run!.id).map((q) => q.photo_id)).toEqual([7])
  await state.db!.exec(
    `UPDATE face_scan_runs SET status='running',started_at=now(),idle_since=now()-interval '10 minutes' WHERE id='${run!.id}';UPDATE face_scan_queue SET status='done' WHERE photo_id=7`,
  )
  const original = (await admin('SELECT started_at FROM face_scan_runs'))[0].started_at
  await uploadFace(9)
  await maintainFaceScan()
  expect((await admin('SELECT total,idle_since,started_at FROM face_scan_runs'))[0]).toEqual({
    total: 2,
    idle_since: null,
    started_at: original,
  })
  expect((await queue()).find((q) => q.photo_id === 9)!.run_id).toBe(run!.id)
  expect(state.calls.filter((c) => c[1] === 'START')).toEqual([[run!.id, 'START']])
})
it('does not revive stopped work when a later upload arrives', async () => {
  state.role = 'personal_photos_maintenance'
  await uploadFace(7)
  const first = await maintainFaceScan()
  await stopScan()
  expect(await maintainFaceScan()).toBeNull()
  await uploadFace(8)
  const second = await maintainFaceScan()
  expect(second!.id).not.toBe(first!.id)
  expect(second!.total).toBe(1)
  expect((await queue()).find((q) => q.photo_id === 7)!.run_id).toBe(first!.id)
})
it('retains new uploads for the next run after idle shutdown seals admission', async () => {
  state.role = 'personal_photos_maintenance'
  await uploadFace(7)
  const first = await maintainFaceScan()
  await state.db!.exec(
    `UPDATE face_scan_runs SET status='running',started_at=now(),accepting_work=false WHERE id='${first!.id}'`,
  )
  await uploadFace(8)
  await maintainFaceScan()
  expect(await admin("SELECT source_id FROM automatic_work_signals WHERE kind='faces'")).toEqual([
    { source_id: 8 },
  ])
  await state.db!.exec(`UPDATE face_scan_runs SET status='completed' WHERE id='${first!.id}'`)
  const second = await maintainFaceScan()
  expect(second!.total).toBe(1)
})

it('keeps automatic signals while disabled, but still recovers an explicitly started run', async () => {
  vi.stubEnv('AUTOMATIC_MEDIA_PROCESSING_ENABLED', 'false')
  await uploadFace(7)
  state.role = 'personal_photos_maintenance'
  expect(await maintainFaceScan()).toBeNull()
  expect(state.calls).toEqual([])
  expect(
    (await admin("SELECT count(*)::int n FROM automatic_work_signals WHERE kind='faces'"))[0].n,
  ).toBe(1)
  state.role = 'personal_photos_app'
  const run = await startScan('ADMIN')
  await state.db!.exec(`UPDATE face_scan_runs SET next_launch_at=now() WHERE id='${run.id}'`)
  state.role = 'personal_photos_maintenance'
  await maintainFaceScan()
  expect(state.calls.filter((c) => c[1] === 'START').every((c) => c[0] === run.id)).toBe(true)
})

it('recovers a crashed batch without new uploads, preserving attempts, completed photos and the cycle deadline', async () => {
  const first = await startScan('ADMIN')
  await state.db!.query(
    `UPDATE face_scan_runs SET status='running',heartbeat_at=now()-interval '5 minutes' WHERE id=$1`,
    [first.id],
  )
  await state.db!.exec(`UPDATE face_scan_queue SET status='done' WHERE photo_id=1;
    UPDATE face_scan_queue SET status='running',attempts=1,claim_token=gen_random_uuid(),lease_until=now()-interval '1 minute' WHERE photo_id=2`)
  state.job = 'FAILED'
  state.role = 'personal_photos_maintenance'
  await maintainFaceScan()
  await state.db!.exec("UPDATE face_scan_runs SET finished_at=now()-interval '1 minute'")
  const next = await maintainFaceScan()
  expect(next).toMatchObject({
    total: 1,
    recovery_attempts: 1,
    cycle_deadline: first.cycle_deadline,
  })
  expect(next!.id).not.toBe(first.id)
  const rows = await admin(
    'SELECT photo_id,run_id,status,attempts FROM face_scan_queue ORDER BY photo_id',
  )
  expect(rows.find((r) => r.photo_id === 1)).toMatchObject({ run_id: first.id, status: 'done' })
  expect(rows.find((r) => r.photo_id === 2)).toMatchObject({
    run_id: next!.id,
    status: 'queued',
    attempts: 1,
  })
  await maintainFaceScan()
  expect((await admin('SELECT count(*)::int n FROM face_scan_runs'))[0].n).toBe(2)
})
it('never recovers a stopped, expired or exhausted crash cycle', async () => {
  const first = await startScan('ADMIN')
  await state.db!.exec(
    "UPDATE face_scan_runs SET status='attention',error='Worker interrupted; automatic recovery pending',finished_at=now()-interval '5 minutes',recovery_attempts=3",
  )
  expect(await maintainFaceScan()).toBeNull()
  await state.db!.exec(
    "UPDATE face_scan_runs SET recovery_attempts=0,cycle_deadline=now()-interval '1 second'",
  )
  expect(await maintainFaceScan()).toBeNull()
  await state.db!.exec(
    "UPDATE face_scan_runs SET cycle_deadline=now()+interval '1 hour',status='cancelled'",
  )
  expect(await maintainFaceScan()).toBeNull()
  expect(state.calls.filter((c) => c[1] === 'START')).toEqual([[first.id, 'START']])
})

it.each([
  'Time budget reached; remaining photos stay queued',
  'Worker interrupted; automatic recovery pending',
])('continues organization after every photo is published: %s', async (reason) => {
  const first = await startScan('ADMIN')
  await state.db!.query(
    `UPDATE face_scan_runs SET status='attention',error=$1,organization_pending=true,finished_at=now()-interval '5 minutes' WHERE id=$2`,
    [reason, first.id],
  )
  await state.db!.exec("UPDATE face_scan_queue SET status='done'")
  state.role = 'personal_photos_maintenance'
  const next = await maintainFaceScan()
  expect(next).toMatchObject({
    status: 'starting',
    total: 0,
    organization_pending: true,
    cycle_deadline: first.cycle_deadline,
  })
  expect(next!.id).not.toBe(first.id)
  expect(state.calls.at(-1)).toEqual([next!.id, 'START'])
  expect(
    (await queue()).filter((row) => row.run_id === first.id).every((row) => row.status === 'done'),
  ).toBe(true)
})
