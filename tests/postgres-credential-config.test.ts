import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ service: '', pools: [] as any[] }))
vi.mock('node:fs', () => ({
  existsSync: (path: string) => path.endsWith('.pg_service.conf') && !!state.service,
  readFileSync: (path: string) => {
    if (path.endsWith('.pg_service.conf')) return state.service
    throw new Error('No credentials in tests')
  },
}))
vi.mock('pg', () => ({
  default: {
    Pool: class {
      constructor(options: any) {
        state.pools.push(options)
      }
      on() {}
      async end() {}
      async connect() {
        return { query: async () => ({ rows: [{ epoch: '1' }] }), release() {} }
      }
    },
  },
}))
import { closePool, pgAuthEpoch } from '@/lib/postgres'

afterEach(async () => {
  await closePool()
  state.service = ''
  state.pools = []
  vi.unstubAllEnvs()
})
it.each(['', 'snowflake_admin', 'postgres', 'personal_photos_maintenance'])(
  'refuses unsafe environment user %s before creating a pool',
  async (user) => {
    vi.stubEnv('PG_HOST', 'test')
    vi.stubEnv('PG_USER', user)
    vi.stubEnv('PG_SSL', 'false')
    await expect(pgAuthEpoch('TEST')).rejects.toThrow(
      'explicitly configured as personal_photos_app',
    )
    expect(state.pools).toHaveLength(0)
  },
)
it.each(['', 'snowflake_admin'])(
  'refuses missing or administrative local service user %s',
  async (user) => {
    vi.stubEnv('PG_HOST', '')
    state.service = `[personal_media_pg]\nhost=localhost\ndbname=example\nuser=${user}\n`
    await expect(pgAuthEpoch('TEST')).rejects.toThrow(
      'explicitly configured as personal_photos_app',
    )
    expect(state.pools).toHaveLength(0)
  },
)
it('retains the explicit application identity and database', async () => {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_DATABASE', 'photo_library')
  vi.stubEnv('PG_SSL', 'false')
  await pgAuthEpoch('TEST')
  expect(state.pools[0]).toMatchObject({ user: 'personal_photos_app', database: 'photo_library' })
})
