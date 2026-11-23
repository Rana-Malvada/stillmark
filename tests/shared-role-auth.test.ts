import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({
  headers: new Headers(),
  epoch: '1',
  store: new Map<string, string>(),
  query: vi.fn(),
  reads: vi.fn(),
}))
vi.mock('next/headers', () => ({ headers: async () => s.headers }))
vi.mock('@/lib/postgres', () => ({
  pgAuthEpoch: async () => s.epoch,
  pgReadRoleCache: async (key: string) => {
    s.reads()
    return s.store.get(key)
  },
  pgWriteRoleCache: async (key: string, value: string) => {
    s.store.set(key, value)
  },
}))
vi.mock('@/lib/snowflake', () => ({ getServiceToken: () => 'service', querySnowflake: s.query }))
beforeEach(() => {
  vi.resetModules()
  s.store.clear()
  s.query.mockReset()
  s.reads.mockReset()
  s.epoch = '1'
  s.headers = new Headers({
    'sf-context-current-user': 'alice',
    'sf-context-current-role': 'viewer',
    'sf-context-current-user-token': 'caller-token',
  })
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('NATIVE_ROLE_CACHE_SIGNING_KEY', 'a'.repeat(64))
})
afterEach(() => vi.unstubAllEnvs())
it('shares verified checks between replicas but bypasses both caches for administrator mutations', async () => {
  s.query.mockResolvedValue([{ IS_ADMIN: true }])
  await (await import('../lib/identity/auth')).getCallerIdentity()
  expect(s.query).toHaveBeenCalledTimes(1)
  vi.resetModules() // Another app replica has no local cache.
  const replica = await import('../lib/identity/auth')
  expect((await replica.getCallerIdentity()).role).toBe('admin')
  expect(s.query).toHaveBeenCalledTimes(1)
  s.query.mockResolvedValue([{ IS_ADMIN: false }])
  await expect(replica.requireAdmin()).rejects.toMatchObject({ status: 403 })
  expect(s.query).toHaveBeenCalledTimes(2)
})
it.each(['user', 'role', 'token', 'epoch'])(
  'does not reuse another %s authorization context',
  async (field) => {
    s.query.mockResolvedValueOnce([{ IS_ADMIN: true }]).mockResolvedValue([{ IS_ADMIN: false }])
    await (await import('../lib/identity/auth')).getCallerIdentity()
    if (field === 'epoch') s.epoch = '2'
    else
      s.headers.set(
        {
          user: 'sf-context-current-user',
          role: 'sf-context-current-role',
          token: 'sf-context-current-user-token',
        }[field]!,
        'changed',
      )
    vi.resetModules()
    expect((await (await import('../lib/identity/auth')).getCallerIdentity()).role).toBe('viewer')
    expect(s.query).toHaveBeenCalledTimes(2)
  },
)
it('does not authorize from a tampered shared entry when Snowflake rejects the caller', async () => {
  s.query.mockResolvedValueOnce([{ IS_ADMIN: true }])
  await (await import('../lib/identity/auth')).getCallerIdentity()
  for (const key of s.store.keys()) s.store.set(key, '{"payload":"{}","mac":"bad"}')
  vi.resetModules()
  s.query.mockRejectedValue(new Error('Invalid OAuth access token'))
  await expect((await import('../lib/identity/auth')).getCallerIdentity()).rejects.toThrow(
    'Invalid OAuth',
  )
})
