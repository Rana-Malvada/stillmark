import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ pools: [] as any[] }))
vi.mock('pg', () => ({
  default: {
    Pool: class {
      options: any
      active = 0
      waiting: Array<() => void> = []
      statements: string[] = []
      constructor(options: any) {
        this.options = { ...options }
        Object.defineProperty(this.options, 'password', {
          value: options.password,
          enumerable: false,
        })
        state.pools.push(this)
      }
      on() {}
      async end() {}
      async connect(): Promise<any> {
        if (this.active >= this.options.max)
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('pool checkout timeout')), 200)
            this.waiting.push(() => {
              clearTimeout(timer)
              resolve()
            })
          })
        this.active++
        return {
          query: async (sql: string) => {
            this.statements.push(sql)
            return { rows: [{ allowed: false }] }
          },
          release: () => {
            this.active--
            this.waiting.shift()?.()
          },
        }
      }
    },
  },
}))
import { closePool, pgIndependent, pgTransaction } from '@/lib/postgres'
import { withAnonymousDatabase, withServiceDatabase } from '@/lib/database/database-context'

afterEach(async () => {
  await closePool()
  state.pools = []
  vi.unstubAllEnvs()
})
it('finishes independent durable writes when all parent pool slots are occupied', async () => {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_SSL', 'false')
  vi.stubEnv('PG_APP_POOL_MAX', '3')
  vi.stubEnv('PG_INDEPENDENT_POOL_MAX', '1')
  let arrived = 0
  let release!: () => void
  const ready = new Promise<void>((r) => {
    release = r
  })
  await Promise.all(
    Array.from({ length: 3 }, () =>
      withAnonymousDatabase(() =>
        pgTransaction(async () => {
          if (++arrived === 3) release()
          await ready
          await pgIndependent('INSERT durable_intent')
        }),
      ),
    ),
  )
  expect(state.pools.map((p) => p.options.max)).toEqual([3, 1])
  expect(state.pools[0].statements).not.toContain('INSERT durable_intent')
  expect(
    state.pools[1].statements.filter((s: string) => s === 'INSERT durable_intent'),
  ).toHaveLength(3)
  expect(state.pools.every((p) => p.active === 0)).toBe(true)
})

it('commits the independent record even when its parent transaction rolls back', async () => {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_SSL', 'false')
  await expect(
    withAnonymousDatabase(() =>
      pgTransaction(async () => {
        await pgIndependent('INSERT durable_intent')
        throw new Error('parent failed')
      }),
    ),
  ).rejects.toThrow('parent failed')
  expect(state.pools[0].statements.at(-1)).toBe('ROLLBACK')
  expect(state.pools[1].statements.at(-1)).toBe('COMMIT')
})
it('keeps maintenance independent writes separate from the app credential', async () => {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_SSL', 'false')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_PASSWORD', 'fake-app-test-only')
  vi.stubEnv('PG_MAINTENANCE_PASSWORD', 'fake-test-only')
  await withAnonymousDatabase(() => pgIndependent('INSERT app_intent'))
  await withServiceDatabase(() => pgIndependent('INSERT maintenance_intent'))
  expect(state.pools).toHaveLength(4)
  expect(state.pools[1].options.user).toBe('personal_photos_app')
  expect(state.pools[3].options.user).toBe('personal_photos_maintenance')
  expect(state.pools[1].options.password).toBe('fake-app-test-only')
  expect(state.pools[3].options.password).toBe('fake-test-only')
  expect(state.pools[1].statements).not.toContain('INSERT maintenance_intent')
})

it('keeps durable writes on direct connections when ordinary queries use PgBouncer', async () => {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_PORT', '5431')
  vi.stubEnv('PG_DIRECT_PORT', '5432')
  vi.stubEnv('PG_PASSWORD', 'fake-app-test-only')
  await withAnonymousDatabase(() => pgIndependent('INSERT durable_intent'))
  expect(state.pools.map((p) => p.options.port)).toEqual([5431, 5432])
  expect(state.pools[1].options.password).toBe('fake-app-test-only')
})
it('fails closed instead of merging independent writes into the same transaction pool', async () => {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_PORT', '5431')
  await expect(withAnonymousDatabase(() => pgIndependent('INSERT durable_intent'))).rejects.toThrow(
    'PG_DIRECT_PORT',
  )
})
it('uses a direct physical session for advisory locks', async () => {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_PORT', '5431')
  vi.stubEnv('PG_DIRECT_PORT', '5432')
  const { withAdvisoryLock } = await import('@/lib/postgres')
  await withAnonymousDatabase(() => withAdvisoryLock('test', async () => 1))
  expect(state.pools.map((p) => p.options.port)).toEqual([5431, 5432])
  expect(state.pools[0].statements).toHaveLength(0)
  expect(state.pools[1].statements[0]).toContain('pg_try_advisory_lock')
})
it('rejects session locks on the transaction-pooling port without a direct endpoint', async () => {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_PORT', '5431')
  const { withAdvisoryLock } = await import('@/lib/postgres')
  await expect(
    withAnonymousDatabase(() => withAdvisoryLock('test', async () => 1)),
  ).rejects.toThrow('PG_DIRECT_PORT')
})
