import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ signals: [] as AbortSignal[] }))
vi.mock('snowflake-sdk/dist/lib/http/stillmark_deadline', () => ({
  runWithSignal: (signal: AbortSignal, fn: () => unknown) => {
    state.signals.push(signal)
    return fn()
  },
}))
import { acquireRoleConnection } from '@/lib/role-connection'
import { ConnectionWaitTimeoutError } from '@/lib/connection-deadline'

afterEach(() => {
  vi.useRealTimers()
  state.signals = []
})
it('cancels a stalled handshake, retries once and releases a late connection unused', async () => {
  vi.useFakeTimers()
  let late!: (c: object) => void
  const old = {}
  const healthy = {}
  const pool = {
    acquire: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            late = r
          }),
      )
      .mockResolvedValueOnce(healthy),
    release: vi.fn(async () => {}),
  }
  const result = acquireRoleConnection(pool)
  await vi.advanceTimersByTimeAsync(4101)
  expect(await result).toBe(healthy)
  expect(state.signals[0].aborted).toBe(true)
  expect(state.signals[1].aborted).toBe(false)
  late(old)
  await vi.advanceTimersByTimeAsync(1)
  expect(pool.release).toHaveBeenCalledWith(old)
  expect(pool.acquire).toHaveBeenCalledTimes(2)
})
it('fails closed within five seconds when both connections stall', async () => {
  vi.useFakeTimers()
  const pool = {
    acquire: vi.fn(() => new Promise<object>(() => {})),
    release: vi.fn(async () => {}),
  }
  const rejected = expect(acquireRoleConnection(pool)).rejects.toBeInstanceOf(
    ConnectionWaitTimeoutError,
  )
  await vi.advanceTimersByTimeAsync(5001)
  await rejected
  expect(pool.acquire).toHaveBeenCalledTimes(2)
  expect(state.signals.every((s) => s.aborted)).toBe(true)
})
it('never retries denial or other non-timeout connection errors', async () => {
  const error = new Error('denied')
  const pool = { acquire: vi.fn().mockRejectedValue(error), release: vi.fn(async () => {}) }
  await expect(acquireRoleConnection(pool)).rejects.toBe(error)
  expect(pool.acquire).toHaveBeenCalledTimes(1)
})

it.each([
  { code: 390303, snowflakeHttpStatus: 503 },
  { code: 401002, snowflakeHttpStatus: 401 },
  { code: 401002, snowflakeHttpStatus: 403 },
  { code: 401002, snowflakeHttpStatus: 429 },
  { message: 'Request to Snowflake failed: 503' },
])('never retries authentication denials or guesses from messages: %j', async (error) => {
  const pool = { acquire: vi.fn().mockRejectedValue(error), release: vi.fn() }
  await expect(acquireRoleConnection(pool)).rejects.toBe(error)
  expect(pool.acquire).toHaveBeenCalledTimes(1)
})

it('allows a healthy three-second login without cancelling and restarting it', async () => {
  vi.useFakeTimers()
  const healthy = {}
  const pool = {
    acquire: vi.fn(
      () => new Promise<object>((resolve) => setTimeout(() => resolve(healthy), 3000)),
    ),
    release: vi.fn(),
  }
  const result = acquireRoleConnection(pool)
  await vi.advanceTimersByTimeAsync(3001)
  expect(await result).toBe(healthy)
  expect(pool.acquire).toHaveBeenCalledTimes(1)
  expect(state.signals[0].aborted).toBe(false)
})
