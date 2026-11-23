import { createTestDatabase } from './fixtures/test-database'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, tx: null as any, snow: vi.fn() }))
vi.mock('@/lib/postgres', () => ({
  pgQuery: async (s: string, p?: unknown[]) => (await (state.tx ?? state.db).query(s, p)).rows,
  pgQueryOne: async (s: string, p?: unknown[]) =>
    (await (state.tx ?? state.db).query(s, p)).rows[0] ?? null,
  pgTransaction: async (fn: () => Promise<unknown>) =>
    state.tx
      ? fn()
      : state.db.transaction(async (t: any) => {
          state.tx = t
          try {
            return await fn()
          } finally {
            state.tx = null
          }
        }),
  withAdvisoryLock: async (_n: string, fn: () => Promise<unknown>) => fn(),
}))
vi.mock('@/lib/database/database-context', () => ({
  withServiceDatabase: (fn: () => unknown) => fn(),
}))
vi.mock('@/lib/snowflake', () => ({ querySnowflake: state.snow }))
import {
  enqueuePreparation,
  maintainPreparation,
  preparationStatus,
  setPreparationSkipped,
  startPreparation,
} from '@/lib/video/video-preparation'
import { claimPlaybackJob, failPlaybackJob } from '@/lib/video-playback-queue'
import { recordPreparationFailure, retryableWorkerFailure } from '../workers/video-gpu/recovery'

beforeAll(async () => {
  state.db = await createTestDatabase({
    schema: false,
    steps: [
      {
        sql: 'CREATE TABLE photos(photo_id int PRIMARY KEY,media_type text,ingest_status text,original_stage_path text,file_size_bytes bigint,source_filename text);CREATE TABLE photo_trash(photo_id int);CREATE TABLE stage_cleanup(path text PRIMARY KEY,next_attempt timestamptz)',
      },
      { file: 'setup/57-video-playback.sql', withoutGrants: true },
      { file: 'setup/58-adaptive-playback.sql', withoutGrants: true },
      { file: 'setup/59-playback-worker.sql', withoutGrants: true },
      { file: 'setup/60-video-preparation.sql', withoutGrants: true },
      '202610202200_video_preparation_exclusions',
      {
        sql: `CREATE ROLE personal_photos_app;CREATE ROLE personal_photos_maintenance;CREATE ROLE personal_photos_face_worker;CREATE ROLE personal_photos_video_worker;
    CREATE SCHEMA photo_security;CREATE FUNCTION photo_security.flag(text) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    CREATE TABLE face_scan_runs(id uuid PRIMARY KEY,status text,created_at timestamptz DEFAULT now());
    CREATE TABLE face_scan_queue(photo_id int,source_path text,status text,run_id uuid);
    CREATE TABLE search_enrichment(photo_id int,status text,source_path text);
    CREATE TABLE search_queue(id bigint,kind text,revision bigint);
    CREATE TABLE search_batch_runs(id uuid)`,
      },
      '202611212100_worker_launch_recovery',
      '202611212200_automatic_media_work',
      '202611212300_worker_warm_idle',
      '202611220100_worker_cycle_recovery',
    ],
  })
}, 30000)
afterAll(async () => {
  vi.unstubAllEnvs()
  await state.db.close()
})
beforeEach(async () => {
  vi.stubEnv('AUTOMATIC_MEDIA_PROCESSING_ENABLED', 'true')
  state.snow.mockReset()
  state.snow.mockResolvedValue([{ RESULT: { status: 'PENDING', pool: 'ACTIVE' } }])
  await state.db.exec(
    "TRUNCATE video_playback,video_preparation_runs,photos;INSERT INTO photos VALUES(1,'video','READY','original-one',100,'one.mov'),(2,'video','READY','original-two',100,'two.mov');UPDATE video_playback SET status='ready',format_version=2,renditions='[{\"stage_path\":\"safe-copy\"}]' WHERE photo_id=1",
  )
  await state.db.exec('TRUNCATE automatic_work_signals')
})
it('snapshots unfinished files and preserves ready outputs and originals', async () => {
  const run = await enqueuePreparation('admin')
  expect(run.total).toBe(1)
  const rows = (
    await state.db.query(
      'SELECT photo_id,status,preparation_run_id,original_path FROM video_playback ORDER BY photo_id',
    )
  ).rows
  expect(rows[0]).toMatchObject({
    status: 'ready',
    preparation_run_id: null,
    original_path: 'original-one',
  })
  expect(rows[1]).toMatchObject({ status: 'queued', preparation_run_id: run.id })
  expect((await claimPlaybackJob(2, false, run.id))?.photo_id).toBe(2)
})
it('repeated starts reuse the same durable run ID', async () => {
  const a = await startPreparation('admin')
  const b = await startPreparation('admin')
  expect(a.id).toBe(b.id)
  expect(state.snow.mock.calls.map((c) => c[1].binds[0])).toEqual([a.id, a.id])
  expect(
    (await state.db.query('SELECT count(*)::int n FROM video_preparation_runs')).rows[0].n,
  ).toBe(1)
})
it('never launches GPU when everything is ready', async () => {
  await state.db.exec(
    'UPDATE video_playback SET status=\'ready\',format_version=2,renditions=\'[{"stage_path":"copy"}]\'',
  )
  expect((await startPreparation('admin')).status).toBe('completed')
  expect(state.snow).not.toHaveBeenCalled()
})
it('survives an ambiguous launch error without allowing a second run', async () => {
  state.snow.mockRejectedValueOnce(Error('network timeout'))
  await expect(startPreparation('admin')).rejects.toThrow('Could not confirm')
  const run = await startPreparation('admin')
  expect(state.snow.mock.calls[0][1].binds[0]).toBe(run.id)
})
it('recovers commit-before-launch automatically with the same queue snapshot and original deadline', async () => {
  const run = await enqueuePreparation('admin')
  const before = (await state.db.query('SELECT * FROM video_playback ORDER BY photo_id')).rows
  state.snow.mockImplementation(async (_sql, { binds }) => [
    { RESULT: { status: binds[1] === 'STATUS' ? 'NOT_FOUND' : 'PENDING' } },
  ])
  await maintainPreparation()
  expect(state.snow.mock.calls.map((c) => c[1].binds)).toEqual([
    [run.id, 'STATUS'],
    [run.id, 'START'],
  ])
  expect((await state.db.query('SELECT * FROM video_playback ORDER BY photo_id')).rows).toEqual(
    before,
  )
  const saved = (await state.db.query('SELECT * FROM video_preparation_runs')).rows[0]
  expect(new Date(saved.created_at).getTime()).toBe(new Date(run.created_at).getTime())
  expect(saved.launch_attempts).toBe(1)
  await maintainPreparation()
  expect(state.snow.mock.calls.filter((c) => c[1].binds[1] === 'START')).toHaveLength(1)
})
it('does not issue another START when the accepted response was lost and the job is pending', async () => {
  state.snow.mockRejectedValueOnce(Error('accepted response lost'))
  await expect(startPreparation('admin')).rejects.toThrow('Could not confirm')
  await state.db.exec('UPDATE video_preparation_runs SET next_launch_at=now()')
  state.snow.mockClear()
  await maintainPreparation()
  await startPreparation('admin')
  expect(state.snow.mock.calls.every((c) => c[1].binds[1] === 'STATUS')).toBe(true)
  expect(
    (await state.db.query('SELECT launch_attempts FROM video_preparation_runs')).rows[0]
      .launch_attempts,
  ).toBe(1)
})
it('reports live progress and recovers a terminated worker', async () => {
  const run = await enqueuePreparation('admin')
  await state.db.exec(
    "UPDATE video_preparation_runs SET status='running',heartbeat_at=NOW()-INTERVAL '10 minutes'",
  )
  state.snow.mockResolvedValue([{ RESULT: { status: 'FAILED', pool: 'SUSPENDED' } }])
  await maintainPreparation()
  const d = await preparationStatus()
  expect(d.run?.status).toBe('attention')
  expect(d.summary).toMatchObject({ ready: 1, pending: 1 })
  expect(d.progress).toMatchObject({ queued: 1 })
  const next = await enqueuePreparation('admin')
  expect(next.id).not.toBe(run.id)
})
it('cancels a stalled launch after thirty minutes without losing its progress', async () => {
  const run = await enqueuePreparation('admin')
  await state.db.exec("UPDATE video_preparation_runs SET created_at=NOW()-INTERVAL '31 minutes'")
  state.snow
    .mockResolvedValueOnce([
      {
        RESULT: {
          status: 'PENDING',
          pool: 'STARTING',
          diagnostics: {
            activeNodes: 0,
            idleNodes: 0,
            targetNodes: 1,
            errorCode: '392507',
            message: 'CAPACITY_ERROR',
          },
        },
      },
    ])
    .mockResolvedValue([{ RESULT: { status: 'CANCELLED', pool: 'SUSPENDED' } }])
  await maintainPreparation()
  const d = await preparationStatus()
  expect(d.run?.status).toBe('attention')
  expect(d.run?.error).toContain('thirty minutes')
  expect(state.snow.mock.calls[0][1].binds).toEqual([run.id, 'STATUS'])
  expect(state.snow.mock.calls[1][1].binds).toEqual([run.id, 'CANCEL'])
  expect(d.progress?.queued).toBe(1)
  expect(d.run?.error).toContain('CAPACITY_ERROR')
})
it('returns saved progress when the Snowflake status service fails', async () => {
  await enqueuePreparation('admin')
  await state.db.exec("UPDATE video_preparation_runs SET heartbeat_at=NOW()-INTERVAL '4 minutes'")
  state.snow.mockRejectedValue(Error('network unavailable'))
  const d = await preparationStatus()
  expect(d.run?.status).toBe('starting')
  expect(state.snow).not.toHaveBeenCalled()
  expect(d.statusWarning).toBeNull()
})

it('does not cancel if worker begins while startup diagnostics are being fetched', async () => {
  await enqueuePreparation('admin')
  await state.db.exec("UPDATE video_preparation_runs SET created_at=NOW()-INTERVAL '31 minutes'")
  state.snow.mockImplementation(async () => {
    await state.db.exec("UPDATE video_preparation_runs SET status='running',heartbeat_at=NOW()")
    return [{ RESULT: { status: 'RUNNING', pool: 'ACTIVE' } }]
  })
  await maintainPreparation()
  const d = await preparationStatus()
  expect(d.run?.status).toBe('running')
  expect(state.snow.mock.calls.every((c) => c[1].binds[1] === 'STATUS')).toBe(true)
})
it('still stops an expired launch if diagnostics are unavailable', async () => {
  const run = await enqueuePreparation('admin')
  await state.db.exec(
    "UPDATE video_preparation_runs SET created_at=NOW()-INTERVAL '31 minutes',error='Saved capacity diagnostic'",
  )
  state.snow
    .mockRejectedValueOnce(Error('status unavailable'))
    .mockResolvedValueOnce([{ RESULT: { status: 'CANCELLED', pool: 'SUSPENDED' } }])
  await maintainPreparation()
  const d = await preparationStatus()
  expect(d.run?.status).toBe('attention')
  expect(d.run?.error).toContain('Saved capacity diagnostic')
  expect(state.snow.mock.calls[1][1].binds).toEqual([run.id, 'CANCEL'])
})

it('allows startup beyond five minutes without cancelling or launching another job', async () => {
  await enqueuePreparation('admin')
  await state.db.exec("UPDATE video_preparation_runs SET created_at=NOW()-INTERVAL '29 minutes'")
  await maintainPreparation()
  const d = await preparationStatus()
  expect(d.run?.status).toBe('starting')
  expect(state.snow.mock.calls.every((c) => c[1].binds[1] === 'STATUS')).toBe(true)
})

it('excludes failed originals from pending counts and future runs until restored', async () => {
  await state.db.exec(
    "UPDATE video_playback SET status='failed',error='no decoder found' WHERE photo_id=2",
  )
  await setPreparationSkipped(2, true)
  const status = await preparationStatus()
  expect(status.summary).toMatchObject({ ready: 1, pending: 0, skipped: 1, total: 2 })
  expect(status.failures).toHaveLength(0)
  expect(status.excluded).toMatchObject([{ photo_id: 2 }])
  expect((await startPreparation('admin')).total).toBe(0)
  expect(state.snow).not.toHaveBeenCalled()
  await setPreparationSkipped(2, false)
  expect((await enqueuePreparation('admin')).total).toBe(1)
})
it('rejects exclusions during active preparation and for ready or missing videos', async () => {
  await expect(setPreparationSkipped(1, true)).rejects.toThrow('Only failed')
  await expect(setPreparationSkipped(999, true)).rejects.toThrow('Only failed')
  await enqueuePreparation('admin')
  await expect(setPreparationSkipped(2, true)).rejects.toThrow('Wait for')
})
it('does not carry exclusions over to replacement originals', async () => {
  await state.db.exec("UPDATE video_playback SET status='failed' WHERE photo_id=2")
  await setPreparationSkipped(2, true)
  await state.db.exec("UPDATE photos SET original_stage_path='replacement' WHERE photo_id=2")
  expect((await preparationStatus()).summary).toMatchObject({ pending: 1, skipped: 0 })
  expect((await enqueuePreparation('admin')).total).toBe(1)
  expect(
    (await state.db.query('SELECT preparation_skipped FROM video_playback WHERE photo_id=2'))
      .rows[0].preparation_skipped,
  ).toBe(false)
})

it('shows excluded failures separately in completed run progress', async () => {
  await enqueuePreparation('admin')
  await state.db.exec(
    "UPDATE video_preparation_runs SET status='attention'; UPDATE video_playback SET status='failed' WHERE photo_id=2",
  )
  await setPreparationSkipped(2, true)
  expect((await preparationStatus()).progress).toMatchObject({ failed: 0, skipped: 1 })
})

async function uploadVideo(id: number) {
  await state.db.query(
    "INSERT INTO photos VALUES($1,'video','READY','new/'||($1::int)::text,100,($1::int)::text||'.mov')",
    [id],
  )
}
it('automatically admits only newly uploaded videos and reuses the warm process', async () => {
  await uploadVideo(3)
  await maintainPreparation()
  const first = (await preparationStatus()).run!
  expect(first.total).toBe(1)
  expect(
    (await state.db.query('SELECT preparation_run_id FROM video_playback WHERE photo_id=2')).rows[0]
      .preparation_run_id,
  ).toBeNull()
  await state.db.exec(
    `UPDATE video_preparation_runs SET status='running',started_at=now(),idle_since=now()-interval '14 minutes';UPDATE video_playback SET status='ready' WHERE photo_id=3`,
  )
  const original = (await preparationStatus()).run!.started_at
  await uploadVideo(4)
  await maintainPreparation()
  const next = (await preparationStatus()).run!
  expect(next).toMatchObject({ id: first.id, total: 2, idle_since: null, started_at: original })
  expect(state.snow.mock.calls.filter((c) => c[1].binds[1] === 'START')).toHaveLength(1)
})
it('does not retry failed or cancelled work merely because new videos arrive', async () => {
  await uploadVideo(3)
  await maintainPreparation()
  const first = (await preparationStatus()).run!
  await state.db.exec(
    "UPDATE video_preparation_runs SET status='attention';UPDATE video_playback SET status='failed' WHERE photo_id=3",
  )
  await maintainPreparation()
  expect((await preparationStatus()).run!.id).toBe(first.id)
  await uploadVideo(4)
  await maintainPreparation()
  const next = (await preparationStatus()).run!
  expect(next.id).not.toBe(first.id)
  expect(next.total).toBe(1)
  expect(
    (await state.db.query('SELECT preparation_run_id FROM video_playback WHERE photo_id=3')).rows[0]
      .preparation_run_id,
  ).toBe(first.id)
})
it('defers uploads once the warm worker has sealed admission', async () => {
  await uploadVideo(3)
  await maintainPreparation()
  await state.db.exec(
    "UPDATE video_preparation_runs SET status='running',started_at=now(),accepting_work=false",
  )
  await uploadVideo(4)
  await maintainPreparation()
  expect(
    (await state.db.query("SELECT source_id FROM automatic_work_signals WHERE kind='playback'"))
      .rows,
  ).toEqual([{ source_id: 4 }])
  await state.db.exec("UPDATE video_preparation_runs SET status='completed'")
  await maintainPreparation()
  expect((await preparationStatus()).run!.total).toBe(1)
})

it('continues untouched queued work only after progress, retaining the original cycle deadline', async () => {
  await uploadVideo(3)
  await uploadVideo(4)
  await maintainPreparation()
  const first = (await preparationStatus()).run!
  await state.db.query("UPDATE video_playback SET status='ready' WHERE photo_id=3")
  await state.db.query(
    "UPDATE video_preparation_runs SET status='attention',error='Time budget reached; remaining videos stay queued' WHERE id=$1",
    [first.id],
  )
  await maintainPreparation()
  const second = (await preparationStatus()).run!
  expect(second.id).not.toBe(first.id)
  expect(second.total).toBe(1)
  expect(second.cycle_deadline).toEqual(first.cycle_deadline)
  expect(
    (
      await state.db.query('SELECT continued_from FROM video_preparation_runs WHERE id=$1', [
        second.id,
      ])
    ).rows[0].continued_from,
  ).toBe(first.id)
  await maintainPreparation()
  expect(
    (await state.db.query('SELECT count(*)::int n FROM video_preparation_runs')).rows[0].n,
  ).toBe(2)
})
it('never loops on no progress or an expired playback cycle', async () => {
  await uploadVideo(3)
  await maintainPreparation()
  const first = (await preparationStatus()).run!
  await state.db.query(
    "UPDATE video_preparation_runs SET status='attention',error='Time budget reached; remaining videos stay queued'",
  )
  await maintainPreparation()
  expect((await preparationStatus()).run!.id).toBe(first.id)
  // A retryable file alone is not progress either: without a published video the
  // worker achieved nothing, so another GPU start is not justified.
  await state.db.exec(
    "UPDATE video_playback SET attempts=1,error='transient' WHERE photo_id=3;UPDATE video_preparation_runs SET error=NULL,finished_at=now()",
  )
  await maintainPreparation()
  expect((await preparationStatus()).run!.id).toBe(first.id)
  await uploadVideo(4)
  await state.db.query('UPDATE video_playback SET preparation_run_id=$1 WHERE photo_id=4', [
    first.id,
  ])
  await state.db.exec(
    "DELETE FROM automatic_work_signals;UPDATE video_playback SET status='ready' WHERE photo_id=3;UPDATE video_preparation_runs SET cycle_deadline=now()-interval '1 second'",
  )
  await maintainPreparation()
  expect((await preparationStatus()).run!.id).toBe(first.id)
})

// The worker image owns these statements; they are repeated here so the coordinator
// is tested against the exact rows a real worker leaves behind.
async function workerStarts(runId: string) {
  await state.db.query(
    "UPDATE video_preparation_runs SET status='running',started_at=NOW(),heartbeat_at=NOW(),error=NULL WHERE id=$1 AND status='starting'",
    [runId],
  )
}
async function workerPublishes(photoId: number) {
  await state.db.query(
    'UPDATE video_playback SET status=\'ready\',renditions=\'[{"stage_path":"copy"}]\'::jsonb,format_version=2,completed_at=NOW(),error=NULL,claim_token=NULL,lease_until=NULL WHERE photo_id=$1',
    [photoId],
  )
}
async function workerFinishes(runId: string, budgetReached: boolean) {
  await state.db.query(
    "UPDATE video_preparation_runs SET accepting_work=false WHERE id=$1 AND status IN ('starting','running')",
    [runId],
  )
  await state.db.query(
    `UPDATE video_preparation_runs SET status=CASE WHEN EXISTS(SELECT 1 FROM video_playback WHERE preparation_run_id=$1 AND status<>'ready') THEN 'attention' ELSE 'completed' END,error=CASE WHEN $2 AND EXISTS(SELECT FROM video_playback WHERE preparation_run_id=$1 AND status='queued' AND attempts=0) THEN 'Time budget reached; remaining videos stay queued' ELSE NULL END,finished_at=NOW(),heartbeat_at=NOW() WHERE id=$1 AND status='running'`,
    [runId, budgetReached],
  )
}
const playbackRow = async (photoId: number) =>
  (
    await state.db.query(
      'SELECT status,attempts,next_attempt_at,error,preparation_run_id FROM video_playback WHERE photo_id=$1',
      [photoId],
    )
  ).rows[0]
const runCount = async () =>
  (await state.db.query('SELECT count(*)::int n FROM video_preparation_runs')).rows[0].n
const backoffElapses = (photoId: number) =>
  state.db.query('UPDATE video_playback SET next_attempt_at=now() WHERE photo_id=$1', [photoId])
/** Two uploads: one is published, the other fails transiently as the worker limit arrives. */
async function deadlineFailure(extraUploads: number[] = []) {
  for (const id of [3, 4, ...extraUploads]) await uploadVideo(id)
  await maintainPreparation()
  const first = (await preparationStatus()).run!
  await workerStarts(first.id)
  const published = (await claimPlaybackJob(2, false, first.id))!
  const transient = (await claimPlaybackJob(2, false, first.id))!
  await workerPublishes(published.photo_id)
  await failPlaybackJob(transient, 'Error: upstream storage timeout')
  await workerFinishes(first.id, true)
  return { first, published, transient, stranded: await playbackRow(transient.photo_id) }
}

it('continues a transient failure at the worker deadline, keeping attempts and backoff, until it is exhausted', async () => {
  const { first, transient, stranded } = await deadlineFailure()
  expect(stranded).toMatchObject({ status: 'queued', attempts: 1, preparation_run_id: first.id })
  expect(new Date(stranded.next_attempt_at).getTime()).toBeGreaterThan(Date.now())
  // The worker reports no time-budget reason because no untouched file remains.
  expect((await preparationStatus()).run).toMatchObject({ status: 'attention', error: null })

  state.snow.mockClear()
  await maintainPreparation()
  const second = (await preparationStatus()).run!
  expect(second.id).not.toBe(first.id)
  expect(second).toMatchObject({ status: 'starting', total: 1 })
  expect(second.cycle_deadline).toEqual(first.cycle_deadline)
  expect(
    (
      await state.db.query('SELECT continued_from FROM video_preparation_runs WHERE id=$1', [
        second.id,
      ])
    ).rows[0].continued_from,
  ).toBe(first.id)
  expect(state.snow.mock.calls.map((c) => c[1].binds)).toEqual([[second.id, 'START']])
  // Adopted as it was left: same attempt count, same backoff time, same diagnostic.
  expect(await playbackRow(transient.photo_id)).toEqual({
    ...stranded,
    preparation_run_id: second.id,
  })
  expect((await preparationStatus()).retries).toMatchObject([
    { photo_id: transient.photo_id, attempts: 1, error: 'Error: upstream storage timeout' },
  ])
  await maintainPreparation()
  expect(await runCount()).toBe(2)

  // The continuation worker honours the backoff, then spends the remaining attempts.
  await workerStarts(second.id)
  expect(await claimPlaybackJob(2, false, second.id)).toBeNull()
  await backoffElapses(transient.photo_id)
  await failPlaybackJob((await claimPlaybackJob(2, false, second.id))!, 'Error: second failure')
  expect(await playbackRow(transient.photo_id)).toMatchObject({ status: 'queued', attempts: 2 })
  await backoffElapses(transient.photo_id)
  await failPlaybackJob((await claimPlaybackJob(2, false, second.id))!, 'Error: third failure')
  await workerFinishes(second.id, false)
  // Exhausted: an explicit failure Activity lists, and nothing left to continue.
  expect(await playbackRow(transient.photo_id)).toMatchObject({ status: 'failed', attempts: 3 })
  const status = await preparationStatus()
  expect(status.failures).toMatchObject([
    { photo_id: transient.photo_id, error: 'Error: third failure' },
  ])
  expect(status.progress).toMatchObject({ queued: 0, failed: 1 })
  expect(status.retries).toEqual([])
  await maintainPreparation()
  expect(await runCount()).toBe(2)
})
it('continues untouched and retryable files together without resetting the retry', async () => {
  const { first, published, transient, stranded } = await deadlineFailure([5])
  expect((await preparationStatus()).run!.error).toBe(
    'Time budget reached; remaining videos stay queued',
  )
  await maintainPreparation()
  const second = (await preparationStatus()).run!
  expect(second.id).not.toBe(first.id)
  expect(second.total).toBe(2)
  expect(second.cycle_deadline).toEqual(first.cycle_deadline)
  expect(await playbackRow(transient.photo_id)).toEqual({
    ...stranded,
    preparation_run_id: second.id,
  })
  const untouched = [3, 4, 5].find((id) => ![published.photo_id, transient.photo_id].includes(id))!
  expect(await playbackRow(untouched)).toMatchObject({
    status: 'queued',
    attempts: 0,
    preparation_run_id: second.id,
  })
})
it('hands a retryable file to the next cycle once its own cycle deadline has passed', async () => {
  const { first, transient, stranded } = await deadlineFailure()
  await state.db.exec("UPDATE video_preparation_runs SET cycle_deadline=now()-interval '1 second'")
  // No cycle time is left, so nothing restarts on its own.
  await maintainPreparation()
  expect(await runCount()).toBe(1)
  // The next cycle is opened by normal admission of a new upload and takes the retry along.
  await uploadVideo(5)
  await maintainPreparation()
  const next = (await preparationStatus()).run!
  expect(next.id).not.toBe(first.id)
  expect(next.total).toBe(2)
  expect(new Date(next.cycle_deadline).getTime()).toBeGreaterThan(Date.now())
  expect(await playbackRow(transient.photo_id)).toEqual({
    ...stranded,
    preparation_run_id: next.id,
  })
  // A warm accepting run adopts a retry stranded on another finished run the same way.
  await workerStarts(next.id)
  await uploadVideo(6)
  await uploadVideo(7)
  await state.db.query(
    "UPDATE video_playback SET preparation_run_id=$1,attempts=2,next_attempt_at=now()+interval '30 seconds',error='transient' WHERE photo_id=6",
    [first.id],
  )
  await state.db.exec('DELETE FROM automatic_work_signals WHERE source_id=6')
  const waiting = await playbackRow(6)
  await maintainPreparation()
  expect((await preparationStatus()).run).toMatchObject({ id: next.id, total: 4 })
  expect(await playbackRow(6)).toEqual({ ...waiting, preparation_run_id: next.id })
})

it('retains automatic signals when disabled without preventing saved manual launch recovery', async () => {
  vi.stubEnv('AUTOMATIC_MEDIA_PROCESSING_ENABLED', 'false')
  await uploadVideo(3)
  await maintainPreparation()
  expect((await preparationStatus()).run).toBeNull()
  expect(state.snow).not.toHaveBeenCalled()
  expect(
    (
      await state.db.query(
        "SELECT count(*)::int n FROM automatic_work_signals WHERE kind='playback'",
      )
    ).rows[0].n,
  ).toBe(1)
  const run = await enqueuePreparation('admin')
  state.snow.mockImplementation(async (_sql, { binds }) => [
    { RESULT: { status: binds[1] === 'STATUS' ? 'NOT_FOUND' : 'PENDING' } },
  ])
  await maintainPreparation()
  expect(state.snow.mock.calls.map((c) => c[1].binds)).toEqual([
    [run.id, 'STATUS'],
    [run.id, 'START'],
  ])
})

it('recovers interrupted video claims without resetting retries or ready outputs', async () => {
  const first = await enqueuePreparation('admin')
  await state.db.exec(
    "UPDATE video_preparation_runs SET status='running',heartbeat_at=now()-interval '5 minutes';UPDATE video_playback SET status='running',attempts=1,lease_until=now()-interval '1 minute',claim_token=gen_random_uuid() WHERE photo_id=2",
  )
  state.snow.mockResolvedValue([{ RESULT: { status: 'FAILED' } }])
  await maintainPreparation()
  await state.db.exec("UPDATE video_preparation_runs SET finished_at=now()-interval '1 minute'")
  await maintainPreparation()
  const next = (await preparationStatus()).run!
  expect(next.id).not.toBe(first.id)
  expect(next.cycle_deadline).toEqual(first.cycle_deadline)
  expect(next.total).toBe(1)
  expect(
    (
      await state.db.query(
        'SELECT status,attempts,claim_token FROM video_playback WHERE photo_id=2',
      )
    ).rows[0],
  ).toEqual({ status: 'queued', attempts: 1, claim_token: null })
  expect(
    (await state.db.query('SELECT status,renditions FROM video_playback WHERE photo_id=1')).rows[0],
  ).toEqual({ status: 'ready', renditions: [{ stage_path: 'safe-copy' }] })
})

it('recovers a caught transient worker error with the original deadline and live-lease fence', async () => {
  const first = await enqueuePreparation('admin')
  const claimed = await claimPlaybackJob(2, false, first.id)
  await state.db.query("UPDATE video_preparation_runs SET status='running' WHERE id=$1", [first.id])
  await recordPreparationFailure(
    first.id,
    Object.assign(new Error('database unavailable'), { code: 'ECONNRESET' }),
  )
  await state.db.query(
    "UPDATE video_preparation_runs SET finished_at=now()-interval '31 seconds' WHERE id=$1",
    [first.id],
  )
  await maintainPreparation()
  expect(
    (await state.db.query('SELECT count(*)::int n FROM video_preparation_runs')).rows[0].n,
  ).toBe(1)
  expect(
    (await state.db.query('SELECT claim_token FROM video_playback WHERE photo_id=2')).rows[0]
      .claim_token,
  ).toBe(claimed!.claim_token)
  await state.db.exec(
    "UPDATE video_playback SET lease_until=now()-interval '1 second' WHERE photo_id=2",
  )
  await maintainPreparation()
  const next = (
    await state.db.query('SELECT * FROM video_preparation_runs WHERE continued_from=$1', [first.id])
  ).rows[0]
  expect(next.cycle_deadline).toEqual(first.cycle_deadline)
  expect(next.recovery_attempts).toBe(1)
  expect(
    (await state.db.query('SELECT attempts,status FROM video_playback WHERE photo_id=2')).rows[0],
  ).toMatchObject({ attempts: 1, status: 'queued' })
})
it.each(['completed', 'attention'])(
  'late worker failure cannot overwrite terminal %s state',
  async (status) => {
    const run = await enqueuePreparation('admin')
    await state.db.query(
      "UPDATE video_preparation_runs SET status=$2,error='Explicit terminal action' WHERE id=$1",
      [run.id, status],
    )
    await recordPreparationFailure(
      run.id,
      Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    )
    expect(
      (
        await state.db.query('SELECT status,error FROM video_preparation_runs WHERE id=$1', [
          run.id,
        ])
      ).rows[0],
    ).toEqual({ status, error: 'Explicit terminal action' })
  },
)
it('does not automatically retry terminal worker configuration or media errors', async () => {
  const run = await enqueuePreparation('admin')
  await recordPreparationFailure(run.id, new Error('Invalid video stream'))
  await state.db.query(
    "UPDATE video_preparation_runs SET finished_at=now()-interval '31 seconds' WHERE id=$1",
    [run.id],
  )
  await maintainPreparation()
  expect(
    (await state.db.query('SELECT count(*)::int n FROM video_preparation_runs')).rows[0].n,
  ).toBe(1)
  expect(retryableWorkerFailure({ code: '42501' })).toBe(false)
  expect(retryableWorkerFailure({ code: '42P01' })).toBe(false)
  expect(retryableWorkerFailure({ code: '57P01' })).toBe(true)
  expect(retryableWorkerFailure(new Error('Query read timeout'))).toBe(true)
})
