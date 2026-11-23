import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ headers: new Headers(), epoch: '1', query: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => state.headers }))
vi.mock('@/lib/postgres', () => ({ pgAuthEpoch: async () => state.epoch }))
vi.mock('@/lib/snowflake', () => ({
  getServiceToken: () => 'service',
  querySnowflake: state.query,
}))
beforeEach(() => {
  vi.resetModules()
  state.epoch = '1'
  state.query.mockReset().mockResolvedValue([{ IS_VIEWER: true }])
  vi.stubEnv('NATIVE_ROLE_CACHE_SIGNING_KEY', undefined)
  vi.stubEnv('NATIVE_ROLE_CACHE_MAX_ENTRIES', undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
function caller(token: string) {
  state.headers = new Headers({
    'sf-context-current-user': 'test-user',
    'sf-context-current-user-token': token,
  })
}
it('retains over 500 distinct contexts without rechecking an unexpired context', async () => {
  const { getCallerIdentity } = await import('../lib/identity/auth')
  for (let i = 0; i < 510; i++) {
    caller(String(i))
    await getCallerIdentity()
  }
  caller('0')
  await getCallerIdentity()
  expect(state.query).toHaveBeenCalledTimes(510)
  state.epoch = '2'
  await getCallerIdentity()
  expect(state.query).toHaveBeenCalledTimes(511)
})
it('evicts by recency and does not extend original grant expiry on reads', async () => {
  vi.stubEnv('NATIVE_ROLE_CACHE_MAX_ENTRIES', '2')
  vi.useFakeTimers()
  vi.setSystemTime(100000)
  const { getCallerIdentity } = await import('../lib/identity/auth')
  for (const token of ['a', 'b', 'a', 'c', 'a']) {
    caller(token)
    await getCallerIdentity()
  }
  expect(state.query).toHaveBeenCalledTimes(3)
  caller('b')
  await getCallerIdentity()
  expect(state.query).toHaveBeenCalledTimes(4)
  vi.advanceTimersByTime(60000)
  caller('a')
  await getCallerIdentity()
  expect(state.query).toHaveBeenCalledTimes(5)
})
