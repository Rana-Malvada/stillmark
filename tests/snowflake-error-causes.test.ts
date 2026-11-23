import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  connect: vi.fn(),
  execute: vi.fn(),
  status: vi.fn(),
  statusError: vi.fn(),
  destroy: vi.fn((cb: () => void) => cb()),
}))
vi.mock('fs', () => ({ default: { readFileSync: () => 'fake-service-token' } }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('snowflake-sdk', () => ({
  default: {
    configure: vi.fn(),
    createPool: () => ({
      use: async (work: (connection: unknown) => unknown) =>
        work({
          execute: state.execute,
          getQueryStatus: state.status,
          isAnError: () => true,
          getQueryStatusThrowIfError: state.statusError,
        }),
    }),
    createConnection: () => ({
      connect: state.connect,
      execute: state.execute,
      getQueryStatus: state.status,
      isAnError: () => true,
      getQueryStatusThrowIfError: state.statusError,
      destroy: state.destroy,
    }),
  },
}))
import {
  querySnowflake,
  querySnowflakeLongRunning,
  queryWithToken,
  queryWithTokenLongRunning,
} from '@/lib/snowflake'
import { diagnosticCode } from '@/lib/diagnostic-schema'

beforeEach(() => {
  vi.clearAllMocks()
  state.connect.mockImplementation((cb) => cb(null))
  state.status.mockResolvedValue('FAILED')
  state.execute.mockImplementation((options) => {
    options.complete(null, { getQueryId: () => 'query-id' })
    return { cancel: vi.fn() }
  })
})
const failure = () => Object.assign(new Error('service failed'), { code: 'ECONNRESET' })
it.each([false, true])('retains the connection failure code for one-shot long=%s', async (long) => {
  const error = failure()
  state.connect.mockImplementation((cb) => cb(error))
  const result = await (
    long ? queryWithTokenLongRunning('SELECT 1', 'token') : queryWithToken('SELECT 1', 'token')
  ).catch((e) => e)
  expect(result.message).toBe('Snowflake connection failed: service failed')
  expect(result.cause).toBe(error)
  expect(diagnosticCode(result)).toBe('ECONNRESET')
  expect(state.execute).not.toHaveBeenCalled()
})
it.each([false, true])(
  'retains execution failure code without extra SQL for long=%s',
  async (long) => {
    const error = failure()
    state.execute.mockImplementation((options) => {
      options.complete(error)
      return { cancel: vi.fn() }
    })
    const result = await (
      long ? queryWithTokenLongRunning('SELECT 1', 'token') : queryWithToken('SELECT 1', 'token')
    ).catch((e) => e)
    expect(result.cause).toBe(error)
    expect(diagnosticCode(result)).toBe('ECONNRESET')
    expect(state.execute).toHaveBeenCalledOnce()
    expect(state.destroy).toHaveBeenCalledOnce()
  },
)
it('retains asynchronous status failure codes and cleans up the connection', async () => {
  const error = failure()
  state.statusError.mockRejectedValue(error)
  const result = await queryWithTokenLongRunning('SELECT 1', 'token').catch((e) => e)
  expect(result.message).toBe('Query failed (queryId=query-id): service failed')
  expect(result.cause).toBe(error)
  expect(diagnosticCode(result)).toBe('ECONNRESET')
  expect(state.execute).toHaveBeenCalledOnce()
  expect(state.destroy).toHaveBeenCalledOnce()
})
it('does not reintroduce redacted password operation details through the new cause', async () => {
  state.execute.mockImplementation((options) => options.complete(new Error('secret-password')))
  const result = await queryWithToken(
    "ALTER USER someone SET PASSWORD='secret-password'",
    'token',
  ).catch((e) => e)
  expect(result.message).toBe('Query failed: Password operation failed')
  expect(result.cause).toBeUndefined()
})

const passwordQuery = "ALTER USER someone SET PASSWORD='private-value'"
it.each(['pooled', 'pooled-long', 'one-shot-long'] as const)(
  'redacts both message and cause for password failures on %s execution',
  async (mode) => {
    state.execute.mockImplementation((options) => {
      options.complete(new Error(passwordQuery))
      return { cancel: vi.fn() }
    })
    const result = await (
      mode === 'pooled'
        ? querySnowflake(passwordQuery)
        : mode === 'pooled-long'
          ? querySnowflakeLongRunning(passwordQuery)
          : queryWithTokenLongRunning(passwordQuery, 'token')
    ).catch((e) => e)
    expect(result.message).toContain('Password operation failed')
    expect(result.message).not.toContain('private-value')
    expect(result.cause).toBeUndefined()
    expect(state.execute).toHaveBeenCalledOnce()
  },
)
it.each(['pooled', 'one-shot'] as const)(
  'redacts password failures returned by asynchronous status on %s',
  async (mode) => {
    state.statusError.mockRejectedValue(new Error(passwordQuery))
    const result = await (
      mode === 'pooled'
        ? querySnowflakeLongRunning(passwordQuery)
        : queryWithTokenLongRunning(passwordQuery, 'token')
    ).catch((e) => e)
    expect(result.message).toBe('Query failed (queryId=query-id): Password operation failed')
    expect(result.cause).toBeUndefined()
  },
)
