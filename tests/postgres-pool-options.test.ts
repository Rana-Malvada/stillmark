import { afterEach, expect, it, vi } from 'vitest'

// Pins the complete option object handed to every pg.Pool, so the shared
// pool-option helper cannot silently change a timeout, size or TLS setting.
const state = vi.hoisted(() => ({ files: {} as Record<string, string>, pools: [] as any[] }))
vi.mock('node:fs', () => ({
  existsSync: (path: string) => Object.keys(state.files).some((name) => path.endsWith(name)),
  readFileSync: (path: string) => {
    const name = Object.keys(state.files).find((candidate) => path.endsWith(candidate))
    if (!name) throw new Error('No such file in tests')
    return state.files[name]
  },
}))
vi.mock('pg', () => ({
  default: {
    Pool: class {
      options: any
      constructor(options: any) {
        state.pools.push(options)
        // Like pg-pool: the stored password is not enumerable.
        this.options = { ...options }
        Object.defineProperty(this.options, 'password', {
          value: options.password,
          enumerable: false,
        })
      }
      on() {}
      async end() {}
      async connect() {
        return { query: async () => ({ rows: [{ epoch: '1', locked: true }] }), release() {} }
      }
    },
  },
}))
import { closePool, pgAuthEpoch, pgIndependent, withAdvisoryLock } from '@/lib/postgres'
import { withAnonymousDatabase, withServiceDatabase } from '@/lib/database/database-context'

afterEach(async () => {
  await closePool()
  state.files = {}
  state.pools = []
  vi.unstubAllEnvs()
})

async function openEveryPool() {
  await pgAuthEpoch()
  await withAnonymousDatabase(() => pgIndependent('SELECT 1'))
  await withAnonymousDatabase(() => withAdvisoryLock('test', async () => 1))
  await withServiceDatabase(() => pgIndependent('SELECT 1'))
  await withServiceDatabase(() => withAdvisoryLock('test', async () => 1))
}

it('builds the deployed app, maintenance, independent and session pools', async () => {
  state.files = { 'deployed-root.crt': 'DEPLOYED CA' }
  vi.stubEnv('PG_HOST', 'db.test')
  vi.stubEnv('PG_PORT', '5431')
  vi.stubEnv('PG_DIRECT_PORT', '5432')
  vi.stubEnv('PG_DATABASE', 'photo_library')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_PASSWORD', 'fake-app-test-only')
  vi.stubEnv('PG_MAINTENANCE_PASSWORD', 'fake-maintenance-test-only')
  vi.stubEnv('PG_SSL_ROOT_CERT', 'deployed-root.crt')
  vi.stubEnv('PG_APP_WORK_MEM_KB', '4096')
  vi.stubEnv('PG_APP_POOL_MAX', '7')
  vi.stubEnv('PG_MAINTENANCE_POOL_MAX', '4')
  vi.stubEnv('PG_INDEPENDENT_POOL_MAX', '3')
  await openEveryPool()

  const app = {
    options: '-c work_mem=4096',
    host: 'db.test',
    port: 5431,
    database: 'photo_library',
    user: 'personal_photos_app',
    password: 'fake-app-test-only',
    ssl: { rejectUnauthorized: true, ca: 'DEPLOYED CA' },
    max: 7,
    statement_timeout: 30000,
    query_timeout: 35000,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  }
  const maintenance = {
    host: 'db.test',
    port: 5432,
    database: 'photo_library',
    user: 'personal_photos_maintenance',
    password: 'fake-maintenance-test-only',
    ssl: { rejectUnauthorized: true, ca: 'DEPLOYED CA' },
    max: 4,
    statement_timeout: 30000,
    query_timeout: 35000,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  }
  expect(state.pools).toStrictEqual([
    app,
    { ...app, port: 5432, max: 3 }, // independent durable writes
    { ...app, port: 5432, max: 3 }, // session locks
    maintenance,
    { ...maintenance, max: 3 }, // independent durable writes
    // The maintenance pool is already direct, so session locks reuse it.
  ])
})

it('builds the local development pool from the service file without a connect timeout', async () => {
  state.files = {
    '.pg_service.conf':
      '[personal_media_pg]\nhost=localhost\nport=5544\ndbname=example\nuser=personal_photos_app\nsslrootcert=local-root.crt\n',
    '.pgpass': 'localhost:5544:example:personal_photos_app:fake-local-test-only\n',
    'local-root.crt': 'LOCAL CA',
  }
  vi.stubEnv('PG_HOST', '')
  await pgAuthEpoch()
  expect(state.pools).toStrictEqual([
    {
      options: undefined,
      host: 'localhost',
      port: 5544,
      database: 'example',
      user: 'personal_photos_app',
      password: 'fake-local-test-only',
      ssl: { ca: 'LOCAL CA', rejectUnauthorized: true },
      max: 10,
      statement_timeout: 30000,
      query_timeout: 35000,
      idleTimeoutMillis: 30000,
    },
  ])
})

it('disables TLS only for an explicit non-production opt-out', async () => {
  vi.stubEnv('PG_HOST', 'db.test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_SSL', 'false')
  await pgAuthEpoch()
  expect(state.pools).toStrictEqual([
    {
      options: undefined,
      host: 'db.test',
      port: 5432,
      database: 'postgres',
      user: 'personal_photos_app',
      password: undefined,
      ssl: false,
      max: 10,
      statement_timeout: 30000,
      query_timeout: 35000,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    },
  ])
})
