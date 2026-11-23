import { afterEach, expect, it, vi } from 'vitest'
import { ConnectionWaitTimeoutError, useConnectionWithDeadline } from '@/lib/connection-deadline'

function fixture() {
  let ready!: (connection: object) => void
  let fail!: (error: Error) => void
  const pool = {
    acquire: vi.fn(
      () =>
        new Promise<object>((resolve, reject) => {
          ready = resolve
          fail = reject
        }),
    ),
    release: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  }
  return {
    pool,
    ready: (connection: object) => ready(connection),
    fail: (error: Error) => fail(error),
  }
}
afterEach(() => vi.useRealTimers())
it('times out acquisition without executing late work and returns the late connection', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const connection = {}
  const work = vi.fn(async () => ['result'])
  const pending = useConnectionWithDeadline(f.pool, work, 5000)
  const rejected = expect(pending).rejects.toBeInstanceOf(ConnectionWaitTimeoutError)
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  f.ready(connection)
  await vi.advanceTimersByTimeAsync(1)
  expect(work).not.toHaveBeenCalled()
  expect(f.pool.release).toHaveBeenCalledWith(connection)
  expect(f.pool.destroy).not.toHaveBeenCalled()
})
it('does not impose an execution timeout once a connection was acquired', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const connection = {}
  let finish!: (result: string) => void
  const work = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve
      }),
  )
  const pending = useConnectionWithDeadline(f.pool, work, 5000)
  f.ready(connection)
  await vi.advanceTimersByTimeAsync(10000)
  finish('result')
  await expect(pending).resolves.toBe('result')
  expect(work).toHaveBeenCalledTimes(1)
  expect(f.pool.release).toHaveBeenCalledWith(connection)
})
it('preserves acquisition errors and consumes failures arriving after timeout', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const error = new Error('denied')
  const pending = useConnectionWithDeadline(f.pool, vi.fn(), 5000)
  const rejected = expect(pending).rejects.toBe(error)
  f.fail(error)
  await rejected
  const late = fixture()
  const p = useConnectionWithDeadline(late.pool, vi.fn(), 5000)
  const timeout = expect(p).rejects.toBeInstanceOf(ConnectionWaitTimeoutError)
  await vi.advanceTimersByTimeAsync(5000)
  await timeout
  late.fail(error)
  await vi.advanceTimersByTimeAsync(1)
  expect(late.pool.release).not.toHaveBeenCalled()
})
it('destroys a failed connection without replaying the statement', async () => {
  const f = fixture()
  const connection = {}
  const error = new Error('statement failed')
  const work = vi.fn(async () => {
    throw error
  })
  const pending = useConnectionWithDeadline(f.pool, work, 5000)
  f.ready(connection)
  await expect(pending).rejects.toBe(error)
  expect(work).toHaveBeenCalledTimes(1)
  expect(f.pool.destroy).toHaveBeenCalledWith(connection)
  expect(f.pool.release).not.toHaveBeenCalled()
})
