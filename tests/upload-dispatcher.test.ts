import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startUploadDispatcher } from '../lib/upload/upload-dispatcher'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
it('polls an empty queue once per interval regardless of processing capacity', async () => {
  const runOne = vi.fn(async () => {})
  const d = startUploadDispatcher({ slots: 56, runOne, onError: vi.fn(), idleDelayMs: () => 1000 })
  await vi.advanceTimersByTimeAsync(0)
  expect(runOne).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(999)
  expect(runOne).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(runOne).toHaveBeenCalledTimes(2)
  d.stop()
  await vi.advanceTimersByTimeAsync(10000)
  expect(runOne).toHaveBeenCalledTimes(2)
})
it('fills processing slots without waiting for completed jobs and bounds concurrent claims', async () => {
  const claims: ReturnType<typeof deferred>[] = []
  const jobs: ReturnType<typeof deferred>[] = []
  let claiming = 0
  let maxClaiming = 0
  let active = 0
  let maxActive = 0
  const d = startUploadDispatcher({
    slots: 4,
    maxClaims: 2,
    idleDelayMs: () => 1000,
    onError: vi.fn(),
    runOne: async (claimed) => {
      const claim = deferred()
      const job = deferred()
      claims.push(claim)
      jobs.push(job)
      maxClaiming = Math.max(maxClaiming, ++claiming)
      await claim.promise
      claiming--
      claimed()
      maxActive = Math.max(maxActive, ++active)
      await job.promise
      active--
    },
  })
  await vi.advanceTimersByTimeAsync(5)
  expect(claims).toHaveLength(1)
  claims[0].resolve()
  await vi.advanceTimersByTimeAsync(5)
  expect(claims).toHaveLength(3)
  claims[1].resolve()
  claims[2].resolve()
  await vi.advanceTimersByTimeAsync(5)
  expect(claims).toHaveLength(4)
  claims[3].resolve()
  await vi.advanceTimersByTimeAsync(5)
  expect(maxClaiming).toBe(2)
  expect(maxActive).toBe(4)
  expect(claims).toHaveLength(4)
  d.stop()
  jobs.forEach((j) => j.resolve())
  await vi.advanceTimersByTimeAsync(5000)
  expect(active).toBe(0)
  expect(claims).toHaveLength(4)
})
it('coalesces empty checks as multiple jobs finish instead of polling once per completion', async () => {
  const jobs: ReturnType<typeof deferred>[] = []
  const runOne = vi.fn(async (claimed: () => void) => {
    if (jobs.length === 4) return
    const job = deferred()
    jobs.push(job)
    claimed()
    await job.promise
  })
  const d = startUploadDispatcher({ slots: 4, runOne, onError: vi.fn(), idleDelayMs: () => 1000 })
  await vi.advanceTimersByTimeAsync(10)
  expect(jobs).toHaveLength(4)
  jobs[0].resolve()
  await vi.advanceTimersByTimeAsync(10)
  const afterEmpty = runOne.mock.calls.length
  jobs.slice(1).forEach((j) => j.resolve())
  await vi.advanceTimersByTimeAsync(100)
  expect(runOne).toHaveBeenCalledTimes(afterEmpty)
  await vi.advanceTimersByTimeAsync(1000)
  expect(runOne).toHaveBeenCalledTimes(afterEmpty + 1)
  d.stop()
})
it('backs off after claim failures, releases its slot and recovers', async () => {
  const onError = vi.fn()
  const runOne = vi.fn().mockRejectedValueOnce(Error('database down')).mockResolvedValue(undefined)
  const d = startUploadDispatcher({ slots: 56, runOne, onError, idleDelayMs: () => 1000 })
  await vi.advanceTimersByTimeAsync(0)
  expect(onError).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(999)
  expect(runOne).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(runOne).toHaveBeenCalledTimes(2)
  d.stop()
})
it('stopping during a claim allows that reserved job to finish but starts no more claims', async () => {
  const claim = deferred()
  const job = deferred()
  const completed = vi.fn()
  const runOne = vi.fn(async (claimed: () => void) => {
    await claim.promise
    claimed()
    await job.promise
    completed()
  })
  const d = startUploadDispatcher({ slots: 8, runOne, onError: vi.fn(), idleDelayMs: () => 1000 })
  await vi.advanceTimersByTimeAsync(0)
  d.stop()
  claim.resolve()
  await vi.advanceTimersByTimeAsync(10)
  expect(runOne).toHaveBeenCalledOnce()
  job.resolve()
  await vi.advanceTimersByTimeAsync(10000)
  expect(completed).toHaveBeenCalledOnce()
  expect(runOne).toHaveBeenCalledOnce()
})
