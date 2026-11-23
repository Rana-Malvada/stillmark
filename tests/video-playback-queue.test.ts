import { createTestDatabase } from './fixtures/test-database'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, tx: null as any, prepare: vi.fn() }))
vi.mock('@/lib/postgres', () => ({
  pgQuery: async (sql: string, p?: unknown[]) => (await (state.tx ?? state.db).query(sql, p)).rows,
  pgQueryOne: async (sql: string, p?: unknown[]) =>
    (await (state.tx ?? state.db).query(sql, p)).rows[0] ?? null,
  pgTransaction: async (fn: () => Promise<unknown>) =>
    state.db.transaction(async (tx: any) => {
      state.tx = tx
      try {
        return await fn()
      } finally {
        state.tx = null
      }
    }),
}))
vi.mock('@/lib/video/video-compression', () => ({ preparePlaybackCopy: state.prepare }))
import { processVideoPlayback } from '@/lib/video/video-playback'
import { claimPlaybackJob, failPlaybackJob, renewPlaybackJob } from '@/lib/video-playback-queue'

beforeAll(async () => {
  state.db = await createTestDatabase({
    schema: false,
    steps: [
      {
        sql: `CREATE TABLE photos(photo_id int PRIMARY KEY,media_type text,ingest_status text,original_stage_path text,file_size_bytes bigint,duration double precision); CREATE TABLE video_analyses(status text); CREATE TABLE photo_trash(photo_id int); CREATE TABLE stage_cleanup(path text PRIMARY KEY,next_attempt timestamptz);`,
      },
      { file: 'setup/57-video-playback.sql', withoutGrants: true },
      'setup/58-adaptive-playback.sql',
      'setup/59-playback-worker.sql',
      { file: 'setup/60-video-preparation.sql', withoutGrants: true },
    ],
  })
}, 30000)
afterAll(async () => {
  await state.db.close()
})
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
  state.prepare.mockReset()
  await state.db.exec(
    "TRUNCATE photos,photo_trash,stage_cleanup,video_playback,video_analyses,video_preparation_runs; INSERT INTO photos VALUES(1,'video','READY','a',100,NULL),(2,'video','READY','b',100,NULL)",
  )
})
it('enqueues new videos once and respects the global resource cap', async () => {
  const first = await claimPlaybackJob()
  expect(first).not.toBeNull()
  expect(await claimPlaybackJob()).toBeNull()
  const second = await claimPlaybackJob(2)
  expect(second?.photo_id).not.toBe(first?.photo_id)
  await state.db.exec("UPDATE photos SET ingest_status='READY'")
  expect((await state.db.query('SELECT count(*)::int n FROM video_playback')).rows[0].n).toBe(2)
})
it('fences an expired worker and backs off retries', async () => {
  const stale = (await claimPlaybackJob())!
  await state.db.exec(
    `UPDATE video_playback SET lease_until=NOW()-INTERVAL '1 minute' WHERE status='running'`,
  )
  expect(await renewPlaybackJob(stale)).toBe(false)
  await claimPlaybackJob()
  await state.db.exec("UPDATE video_playback SET next_attempt_at=NOW()-INTERVAL '1 second'")
  const replacement = (await claimPlaybackJob(2))!
  expect(replacement.photo_id).toBe(stale.photo_id)
  expect(replacement.claim_token).not.toBe(stale.claim_token)
  await failPlaybackJob(stale)
  expect(await renewPlaybackJob(replacement)).toBe(true)
  await failPlaybackJob(replacement)
  expect(await claimPlaybackJob(2)).toBeNull()
})
it('replacing an original invalidates the old worker claim', async () => {
  const job = (await claimPlaybackJob())!
  await state.db.query("UPDATE photos SET original_stage_path='replacement' WHERE photo_id=$1", [
    job.photo_id,
  ])
  expect(await renewPlaybackJob(job)).toBe(false)
  const next = await claimPlaybackJob()
  const other = await claimPlaybackJob(2)
  expect([next?.original_path, other?.original_path]).toContain('replacement')
})
it('does not enqueue photos or unfinished uploads and preserves ready copies', async () => {
  await state.db.exec(
    "INSERT INTO photos VALUES(3,'photo','READY','c',100,NULL),(4,'video','UPLOADING','d',100,NULL); UPDATE video_playback SET status='ready'; UPDATE photos SET ingest_status='READY' WHERE photo_id=1",
  )
  expect(await claimPlaybackJob()).toBeNull()
  await state.db.exec("UPDATE photos SET ingest_status='READY' WHERE photo_id=4")
  expect((await claimPlaybackJob())?.photo_id).toBe(4)
})
it('retains trash playback and schedules cleanup only after permanent deletion', async () => {
  await state.db.exec(
    "INSERT INTO photo_trash VALUES(1); UPDATE video_playback SET status='ready',stage_path='display/one',renditions='[{\"stage_path\":\"display/two\"}]' WHERE photo_id=1; DELETE FROM photos WHERE photo_id=1",
  )
  expect(
    (await state.db.query('SELECT count(*)::int n FROM video_playback WHERE photo_id=1')).rows[0].n,
  ).toBe(1)
  await state.db.exec('DELETE FROM photo_trash WHERE photo_id=1')
  expect(
    (await state.db.query('SELECT count(*)::int n FROM video_playback WHERE photo_id=1')).rows[0].n,
  ).toBe(0)
  expect(
    (await state.db.query('SELECT path FROM stage_cleanup ORDER BY path')).rows.map(
      (r: any) => r.path,
    ),
  ).toEqual(['display/one', 'display/two'])
})
const copy = {
  path: 'display/new',
  manifest: 'manifest',
  bytes: 100,
  duration: 12,
  renditions: [{ name: '720', stage_path: 'display/new', playlist: 'manifest', bandwidth: 100 }],
}
it('publishes validated copies atomically and records duration', async () => {
  vi.stubEnv('VIDEO_CONVERSION_ENABLED', 'true')
  state.prepare.mockImplementation(async () => {
    await state.db.exec("INSERT INTO stage_cleanup VALUES('display/new',NOW()+INTERVAL '24 hours')")
    return copy
  })
  await processVideoPlayback()
  const row = (
    await state.db.query(
      "SELECT p.duration,v.status,v.claim_token FROM photos p JOIN video_playback v USING(photo_id) WHERE v.status='ready'",
    )
  ).rows[0]
  expect(row).toEqual({ duration: 12, status: 'ready', claim_token: null })
  expect(
    (await state.db.query("SELECT * FROM stage_cleanup WHERE path='display/new'")).rows,
  ).toHaveLength(0)
})
it('never publishes a result after its claim is invalidated', async () => {
  vi.stubEnv('VIDEO_CONVERSION_ENABLED', 'true')
  state.prepare.mockImplementation(async () => {
    await state.db.exec(
      "UPDATE video_playback SET claim_token=NULL,status='queued' WHERE status='running'; INSERT INTO stage_cleanup VALUES('display/new',NOW()+INTERVAL '24 hours')",
    )
    return copy
  })
  await processVideoPlayback()
  expect(
    (await state.db.query("SELECT * FROM video_playback WHERE status='ready'")).rows,
  ).toHaveLength(0)
  expect(
    (await state.db.query("SELECT * FROM stage_cleanup WHERE path='display/new'")).rows,
  ).toHaveLength(1)
})
it('does not claim or encode while conversion is disabled', async () => {
  vi.stubEnv('VIDEO_CONVERSION_ENABLED', 'false')
  await processVideoPlayback()
  expect(state.prepare).not.toHaveBeenCalled()
})

it('dedicated GPU workers do not wait for unrelated AI analysis', async () => {
  await state.db.exec("INSERT INTO video_analyses VALUES('running')")
  expect(await claimPlaybackJob()).toBeNull()
  expect(await claimPlaybackJob(2, false)).not.toBeNull()
})

it('retries after 10 and 30 seconds and stops after three attempts', async () => {
  await state.db.exec('DELETE FROM video_playback WHERE photo_id=1')
  for (const attempt of [1, 2, 3]) {
    const job = (await claimPlaybackJob(2, false))!
    expect(job).not.toBeNull()
    await failPlaybackJob(job)
    const row = (
      await state.db.query(
        'SELECT status,attempts,EXTRACT(EPOCH FROM next_attempt_at-NOW()) AS wait FROM video_playback WHERE photo_id=2',
      )
    ).rows[0]
    expect(row.attempts).toBe(attempt)
    expect(row.status).toBe(attempt === 3 ? 'failed' : 'queued')
    expect(Number(row.wait)).toBeGreaterThan((attempt === 1 ? 10 : 30) - 2)
    expect(Number(row.wait)).toBeLessThanOrEqual(attempt === 1 ? 10 : 30)
    await state.db.exec("UPDATE video_playback SET next_attempt_at=NOW()-INTERVAL '1 second'")
  }
  expect(await claimPlaybackJob(2, false)).toBeNull()
})
