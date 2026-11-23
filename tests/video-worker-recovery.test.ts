import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; params?: unknown[] }>,
  heartbeatFailure: false,
  claim: vi.fn(),
}))
vi.mock('@/lib/postgres', () => ({
  pgQuery: async (sql: string, params?: unknown[]) => {
    state.queries.push({ sql, params })
    if (state.heartbeatFailure && sql.startsWith('UPDATE video_preparation_runs SET heartbeat_at='))
      throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    return []
  },
  pgQueryOne: async (sql: string) =>
    sql.includes('cycle_deadline')
      ? { cycle_deadline: new Date(Date.now() + 3600000).toISOString() }
      : { state: 'idle' },
  pgTransaction: async (fn: () => unknown) => fn(),
}))
vi.mock('@/lib/video-playback-queue', () => ({
  claimPlaybackJob: state.claim,
  renewPlaybackJob: vi.fn(),
  failPlaybackJob: vi.fn(),
}))
let exit: ReturnType<typeof vi.spyOn>
let priorTerm: ReturnType<typeof process.listeners>
let priorInt: ReturnType<typeof process.listeners>
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  state.queries = []
  state.heartbeatFailure = false
  state.claim.mockReset().mockResolvedValue(null)
  vi.stubEnv('WORKER_RUN_ID', '7d6dab00-1234-4234-8234-123456789012')
  vi.stubEnv('WORKER_CONCURRENCY', '2')
  vi.stubEnv('WORKER_MAX_SECONDS', '7200')
  priorTerm = process.listeners('SIGTERM')
  priorInt = process.listeners('SIGINT')
  exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
})
afterEach(() => {
  for (const listener of process.listeners('SIGTERM'))
    if (!priorTerm.includes(listener)) process.removeListener('SIGTERM', listener)
  for (const listener of process.listeners('SIGINT'))
    if (!priorInt.includes(listener)) process.removeListener('SIGINT', listener)
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
it('turns a failed run heartbeat into recoverable interruption instead of attention with no error', async () => {
  state.heartbeatFailure = true
  await import('../workers/video-gpu/worker')
  await vi.advanceTimersByTimeAsync(35001)
  expect(exit).toHaveBeenCalledWith(1)
  const failure = state.queries.find((q) => q.sql.includes("SET status='attention'"))!
  expect(failure.params?.[1]).toBe('Worker interrupted; automatic recovery pending')
  expect(failure.sql).toContain("status IN ('starting','running')")
  expect(state.queries.some((q) => q.sql.includes('SET status=CASE'))).toBe(false)
})
it('waits for another lane to finish before saving a failed claim as recoverable', async () => {
  let secondLaneFinished = false
  state.claim
    .mockImplementationOnce(async () => {
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    })
    .mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      secondLaneFinished = true
      return null
    })
  await import('../workers/video-gpu/worker')
  await vi.advanceTimersByTimeAsync(20)
  expect(exit).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(5041)
  expect(secondLaneFinished).toBe(true)
  expect(exit).toHaveBeenCalledWith(1)
  expect(state.queries.find((q) => q.sql.includes("SET status='attention'"))?.params?.[1]).toBe(
    'Worker interrupted; automatic recovery pending',
  )
})

it.each(['SIGTERM', 'SIGINT'] as const)(
  'recovers graceful %s infrastructure interruption without bypassing terminal fences',
  async (signal) => {
    await import('../workers/video-gpu/worker')
    const prior = signal === 'SIGTERM' ? priorTerm : priorInt
    const handler = process.listeners(signal).find((listener) => !prior.includes(listener))!
    Reflect.apply(handler, process, [signal])
    await vi.advanceTimersByTimeAsync(5001)
    expect(exit).toHaveBeenCalledWith(1)
    const failure = state.queries.find((q) => q.sql.includes("SET status='attention'"))!
    expect(failure.params?.[1]).toBe('Worker interrupted; automatic recovery pending')
    expect(failure.sql).toContain("status IN ('starting','running')")
    expect(state.queries.some((q) => q.sql.includes('SET status=CASE'))).toBe(false)
  },
)
