import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  use: vi.fn(),
  createPool: vi.fn(),
}))
vi.mock('fs', () => ({ default: { readFileSync: () => 'fake-service-token' } }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'sf-context-current-user-token': 'caller-token' }),
}))
vi.mock('snowflake-sdk', () => ({
  default: {
    configure: vi.fn(),
    createPool: (...args: unknown[]) => {
      state.createPool(...args)
      return state
    },
  },
}))
import { querySnowflake } from '@/lib/snowflake'
import { ConnectionWaitTimeoutError } from '@/lib/connection-deadline'

afterEach(() => {
  state.use.mockClear()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

it('isolates short-timeout role connections from ordinary caller and owner work', async () => {
  vi.stubEnv('SNOWFLAKE_SDK_QUIET', '1')
  state.use.mockResolvedValue([])
  state.acquire.mockResolvedValue({ execute: ({ complete }: any) => complete(null, null, []) })
  await querySnowflake('SELECT IS_ROLE_IN_SESSION(?)', {
    callersRights: true,
    connectionProfile: 'role-check',
    binds: ['viewer'],
  })
  await querySnowflake('SELECT IS_ROLE_IN_SESSION(?)', {
    callersRights: true,
    connectionProfile: 'role-check',
    binds: ['viewer'],
  })
  await querySnowflake('SELECT 1', { callersRights: true })
  await querySnowflake('SELECT 1')
  const configs = state.createPool.mock.calls.map(([config]) => config)
  expect(configs.filter((c) => c.timeout === 5000)).toHaveLength(1)
  expect(configs.find((c) => c.timeout === 5000).sfRetryMaxLoginRetries).toBe(0)
  expect(state.createPool.mock.calls.find(([c]) => c.timeout === 5000)?.[1]).toMatchObject({
    acquireTimeoutMillis: 5000,
  })
  expect(
    configs.some((c) => c.token === 'fake-service-token.caller-token' && c.timeout === undefined),
  ).toBe(true)
  expect(configs.some((c) => c.token === 'fake-service-token' && c.timeout === undefined)).toBe(
    true,
  )
  await expect(querySnowflake('SELECT 1', { connectionProfile: 'role-check' })).rejects.toThrow(
    'requires caller rights',
  )
})
it('applies the caller role acquisition deadline without executing a late SQL request', async () => {
  state.release.mockClear()
  vi.useFakeTimers()
  vi.stubEnv('SNOWFLAKE_SDK_QUIET', '1')
  let ready!: (connection: any) => void
  state.acquire.mockImplementation(
    () =>
      new Promise((resolve) => {
        ready = resolve
      }),
  )
  const conn = { execute: vi.fn() }
  const pending = querySnowflake('SELECT IS_ROLE_IN_SESSION(?)', {
    callersRights: true,
    binds: ['role'],
    connectionWaitMs: 5000,
  })
  const rejected = expect(pending).rejects.toBeInstanceOf(ConnectionWaitTimeoutError)
  await vi.advanceTimersByTimeAsync(5001)
  await rejected
  ready(conn)
  await vi.advanceTimersByTimeAsync(1)
  expect(conn.execute).not.toHaveBeenCalled()
  expect(state.release).toHaveBeenCalledWith(conn)
  expect(state.use).not.toHaveBeenCalled()
})
