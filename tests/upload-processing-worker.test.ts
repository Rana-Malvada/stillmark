import { afterEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  epoch: vi.fn(),
  complete: vi.fn(),
  pg: vi.fn(),
  authority: vi.fn(),
}))
vi.mock('@/lib/upload/upload-queue-database', () => ({
  uploadQueuePool: () => ({ query: m.query, connect: m.connect }),
}))
vi.mock('@/lib/postgres', () => ({
  pgAuthEpoch: m.epoch,
  pgAuthMainAdmin: async () => false,
  pgQuery: m.pg,
  pgQueryOne: m.authority,
}))
vi.mock('@/lib/upload/upload-sessions', () => ({ completeUpload: m.complete }))
import { claimUploadJob, processUploadJob } from '@/lib/upload/upload-processing-worker'
import { databaseContext } from '@/lib/database/database-context'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})
const job = {
  upload_id: 'id',
  owner: 'ALICE',
  body: { fileName: 'a.jpg' },
  caller: { username: 'ALICE', role: 'viewer' as const, mainAdmin: false },
  auth_epoch: '1',
  lease_token: 'token',
  attempts: 1,
  created_at: new Date().toISOString(),
}
it('uses owner-scoped publication with a lease, not browser headers or maintenance privileges', async () => {
  m.epoch.mockResolvedValue('1')
  m.query.mockResolvedValue({ rows: [] })
  m.pg.mockResolvedValue([])
  m.complete.mockImplementation(async () => {
    const ctx = databaseContext.getStore()
    expect(ctx?.kind).toBe('request')
    if (ctx?.kind === 'request')
      expect(await ctx.identity).toMatchObject({
        username: 'ALICE',
        canWrite: true,
        mainAdmin: false,
      })
  })
  await processUploadJob(job)
  expect(m.complete).toHaveBeenCalledWith('ALICE', job.body, job.caller, 'token')
  expect(m.query.mock.calls.at(-1)?.[0]).toContain("state='done'")
})
it('revoked authorization never enters ingestion', async () => {
  m.epoch.mockResolvedValue('2')
  m.query.mockResolvedValue({ rows: [] })
  await processUploadJob(job)
  expect(m.complete).not.toHaveBeenCalled()
  expect(m.query.mock.calls.at(-1)?.[1][2]).toBe('failed')
})
it('does not process a deleted account even when its global authorization epoch is unchanged', async () => {
  vi.stubEnv('CUSTOMER_ACCOUNTS_ENABLED', 'true')
  m.epoch.mockResolvedValue('1')
  m.query.mockResolvedValue({ rows: [] })
  m.authority.mockResolvedValue({ allowed: false })
  await processUploadJob(job)
  expect(m.complete).not.toHaveBeenCalled()
  expect(m.pg).not.toHaveBeenCalled()
  expect(m.query.mock.calls.at(-1)?.[1][2]).toBe('failed')
})
it('closing pool admission prevents claims until the dedicated worker is ready', async () => {
  const query = vi.fn().mockImplementation(async (sql: string) => ({
    rows: sql.includes('SELECT route') ? [{ route: 'pool', phase: 'suspending' }] : [],
  }))
  const release = vi.fn()
  m.connect.mockResolvedValue({ query, release })
  expect(await claimUploadJob()).toBeUndefined()
  expect(query.mock.calls.some(([sql]) => sql.includes('WITH ready'))).toBe(false)
  expect(query.mock.calls[1][0]).toContain('pg_advisory_xact_lock_shared')
  expect(release).toHaveBeenCalledOnce()
})

it('claims work only through ready pool admission and records the pool executor', async () => {
  const query = vi.fn().mockImplementation(async (sql: string) => ({
    rows: sql.includes('SELECT route')
      ? [{ route: 'pool', phase: 'pool' }]
      : sql.includes('WITH ready')
        ? [job]
        : [],
  }))
  const release = vi.fn()
  m.connect.mockResolvedValue({ query, release })
  expect(await claimUploadJob()).toEqual(job)
  const claim = query.mock.calls.find(([sql]) => sql.includes('WITH ready'))
  expect(claim?.[1]).toEqual([expect.any(String), 'pool'])
  expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT')
  expect(release).toHaveBeenCalledOnce()
})

it('cancels the processing context when its queue lease is lost', async () => {
  vi.useFakeTimers()
  m.epoch.mockResolvedValue('1')
  m.pg.mockResolvedValue([])
  m.query.mockResolvedValue({ rows: [], rowCount: 0 })
  let processingSignal: AbortSignal | undefined
  m.complete.mockImplementation(async () => {
    const ctx = databaseContext.getStore()
    if (ctx?.kind === 'request') processingSignal = ctx.signal
    await new Promise<void>((_, reject) => {
      processingSignal!.addEventListener('abort', () => reject(processingSignal!.reason), {
        once: true,
      })
    })
  })
  const running = processUploadJob(job)
  await vi.advanceTimersByTimeAsync(30000)
  await running
  expect(processingSignal?.aborted).toBe(true)
  expect(m.query.mock.calls.some(([sql]) => sql.includes("state='done'"))).toBe(false)
  expect(m.query.mock.calls.at(-1)?.[0]).toContain('lease_token=$2')
})

it('records a sanitized background failure while retaining durable retry behavior', async () => {
  m.epoch.mockResolvedValue('1')
  m.query.mockResolvedValue({ rows: [] })
  m.pg.mockResolvedValue([])
  const cause = Object.assign(new Error('secret password and private filename.jpg'), {
    code: 'ECONNRESET',
  })
  m.complete.mockRejectedValue(new Error('private SQL', { cause }))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const id = '984b87bd-cc95-4f82-849e-89081c773a0f'
  await processUploadJob({ ...job, upload_id: id })
  expect(log).toHaveBeenCalledOnce()
  expect(log).toHaveBeenCalledWith('[upload-queue]', {
    event: 'upload-processing-failed',
    uploadId: id,
    attempt: 1,
    phase: 'complete',
    code: 'ECONNRESET',
    retry: true,
  })
  expect(m.query.mock.calls.at(-1)?.[1].slice(2, 4)).toEqual([
    'queued',
    'Processing failed; retry this file if automatic recovery does not complete',
  ])
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/password|filename|private SQL/)
})
it('a diagnostic sink failure cannot prevent queue recovery', async () => {
  m.epoch.mockResolvedValue('1')
  m.query.mockResolvedValue({ rows: [] })
  m.pg.mockResolvedValue([])
  m.complete.mockRejectedValue(new Error('synthetic failure'))
  vi.spyOn(console, 'error').mockImplementation(() => {
    throw new Error('log unavailable')
  })
  await processUploadJob({ ...job, attempts: 5 })
  expect(m.query.mock.calls.at(-1)?.[1][2]).toBe('failed')
  expect(m.query.mock.calls.at(-1)?.[0]).toContain('lease_token=NULL,lease_until=NULL')
})
it('successful uploads do not add failure logging', async () => {
  m.epoch.mockResolvedValue('1')
  m.query.mockResolvedValue({ rows: [] })
  m.pg.mockResolvedValue([])
  m.complete.mockResolvedValue(undefined)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await processUploadJob(job)
  expect(log).not.toHaveBeenCalled()
})
