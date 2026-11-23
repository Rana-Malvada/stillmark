import { afterEach, expect, it, vi } from 'vitest'
import {
  withAnonymousDatabase,
  withDatabaseRequest,
  withPublicDatabase,
  withServiceDatabase,
} from '@/lib/database/database-context'

const state = vi.hoisted(() => ({
  clients: [] as any[],
  options: [] as any[],
  failAuth: false,
  username: 'ALICE',
}))
vi.mock('@/lib/identity/auth', () => ({
  requireAuth: async () => {
    if (state.failAuth) throw new Error('Unauthenticated')
    return { username: state.username, role: 'viewer' }
  },
  getCallerIdentity: async () => {
    if (state.failAuth) throw new Error('Unauthenticated')
    return { username: state.username, role: 'viewer' }
  },
  hasAccessManagerRole: async () => false,
}))
vi.mock('pg', () => ({
  default: {
    Pool: class {
      constructor(options: unknown) {
        state.options.push(options)
      }
      on() {}
      async end() {}
      async query() {
        return { rows: [{ allowed: false }] }
      }
      async connect() {
        const c = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }
        state.clients.push(c)
        return c
      }
    },
  },
}))
import { closePool, pgQuery, pgTransaction } from '@/lib/postgres'

afterEach(async () => {
  await closePool()
  state.clients = []
  state.options = []
  state.failAuth = false
  vi.unstubAllEnvs()
})
function env() {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_SSL', 'false')
}
it('rejects missing authentication before borrowing any catalog connection', async () => {
  env()
  state.failAuth = true
  await expect(withDatabaseRequest(() => pgQuery('SELECT * FROM photos'))()).rejects.toThrow(
    'Unauthenticated',
  )
  expect(state.clients).toHaveLength(0)
})
it('sets verified identity locally for writes and clears it on commit', async () => {
  env()
  await withDatabaseRequest(() => pgQuery('UPDATE photos SET favorite=true'))()
  const q = state.clients.at(-1).query.mock.calls
  expect(q[0][0]).toBe('BEGIN')
  expect(q[1][1]).toEqual(['ALICE', 'false', 'false', 'false', 'true', 'false', ''])
  expect(q.at(-1)[0]).toBe('COMMIT')
  expect(state.clients.at(-1).release).toHaveBeenCalledWith(false)
})
it('public and readiness scopes never fall back to an authenticated or service identity', async () => {
  env()
  state.failAuth = true
  await withPublicDatabase('a'.repeat(64), () => pgQuery('SELECT * FROM photos'))
  await withAnonymousDatabase(() => pgQuery('SELECT * FROM photos LIMIT 0'))
  expect(state.clients[0].query.mock.calls[1][1]).toEqual([
    '',
    'false',
    'false',
    'false',
    'false',
    'false',
    'a'.repeat(64),
  ])
  expect(state.clients[1].query.mock.calls[1][1]).toEqual([
    '',
    'false',
    'false',
    'false',
    'false',
    'false',
    '',
  ])
})
it('service entry points require their separate credential and cannot silently use the web pool', async () => {
  env()
  vi.stubEnv('PG_MAINTENANCE_PASSWORD', '')
  await expect(withServiceDatabase(() => pgQuery('SELECT * FROM photos'))).rejects.toThrow(
    'Maintenance database credential unavailable',
  )
  expect(state.clients).toHaveLength(0)
})
it('refuses changing to a service identity inside a user transaction', async () => {
  env()
  await expect(
    withDatabaseRequest(() =>
      pgTransaction(() => withServiceDatabase(() => pgQuery('SELECT * FROM photos'))),
    )(),
  ).rejects.toThrow('Database scope cannot change')
  expect(state.clients.at(-1).query.mock.calls.at(-1)[0]).toBe('ROLLBACK')
})

it('media lookup uses one catalog transaction and releases it before returning the result', async () => {
  env()
  const { lookupMedia } = await import('@/lib/media/media-lookup')
  await withDatabaseRequest(() => lookupMedia('thumbnails/test.jpg'))()
  const transactions = state.clients.filter((c) => c.query.mock.calls[0]?.[0] === 'BEGIN')
  expect(transactions).toHaveLength(1)
  expect(transactions[0].query.mock.calls).toHaveLength(4)
  expect(transactions[0].query.mock.calls[2][0]).toContain('WITH candidate AS MATERIALIZED')
  expect(transactions[0].release).toHaveBeenCalledWith(false)
})

it('applies the configured connection cap without changing request identity isolation', async () => {
  env()
  vi.stubEnv('PG_APP_POOL_MAX', '3')
  await withDatabaseRequest(() => pgQuery('SELECT * FROM photos'))()
  expect(state.options[0].max).toBe(3)
  expect(state.clients.at(-1).release).toHaveBeenCalledWith(false)
})

it('opt-in atomic media lookup uses one statement and no explicit transaction', async () => {
  env()
  vi.stubEnv('PG_MEDIA_LOOKUP_FUNCTION_ENABLED', 'true')
  const { lookupMedia } = await import('@/lib/media/media-lookup')
  await withDatabaseRequest(() => lookupMedia('thumbnails/test.jpg'))()
  const client = state.clients.find((c) => c.query.mock.calls[0]?.[0].includes('lookup_media'))
  expect(client.query.mock.calls).toHaveLength(1)
  expect(client.query.mock.calls[0][0]).toBe(
    'SELECT photo_security.lookup_media($1,$2::jsonb) AS photo',
  )
  expect(JSON.parse(client.query.mock.calls[0][1][1])).toMatchObject({
    username: state.username,
    mainAdmin: false,
  })
  expect(client.release).toHaveBeenCalledWith(false)
})

it('keeps cancellation when narrowing a request to public or anonymous permissions', async () => {
  env()
  const { databaseContext, databaseSignal } = await import('@/lib/database/database-context')
  const controller = new AbortController()
  await withDatabaseRequest(async (_req: Request) => {
    const originalSignal = databaseSignal()
    await withPublicDatabase('a'.repeat(64), async () => {
      expect(databaseContext.getStore()).toEqual({
        kind: 'public',
        hash: 'a'.repeat(64),
        signal: originalSignal,
      })
      await expect(
        pgTransaction(async () => {
          controller.abort()
          databaseSignal()?.throwIfAborted()
        }),
      ).rejects.toThrow()
    })
    expect(state.clients.at(-1).release).toHaveBeenCalledExactlyOnceWith(true)
    withAnonymousDatabase(() => expect(databaseSignal()?.aborted).toBe(true))
    withServiceDatabase(() => expect(databaseSignal()).toBeUndefined())
  })(new Request('https://app/share/test', { signal: controller.signal }))
})

it('rejects canceled public requests before borrowing a database client', async () => {
  env()
  const controller = new AbortController()
  controller.abort()
  await expect(
    withPublicDatabase('a'.repeat(64), () => pgQuery('SELECT * FROM photos'), controller.signal),
  ).rejects.toThrow('Request aborted')
  expect(state.clients).toHaveLength(0)
})

it('only explicitly request-bound service reads inherit cancellation, without request identity', async () => {
  const { databaseContext, databaseSignal } = await import('@/lib/database/database-context')
  const controller = new AbortController()
  await databaseContext.run({ kind: 'request', signal: controller.signal }, async () => {
    await withServiceDatabase(async () => {
      expect(databaseContext.getStore()?.kind).toBe('service')
      expect(databaseSignal()).toBe(controller.signal)
      controller.abort()
      expect(() => databaseSignal()?.throwIfAborted()).toThrow()
      expect(databaseContext.getStore()).not.toHaveProperty('requestBinding')
    }, databaseSignal())
    withServiceDatabase(() => expect(databaseSignal()).toBeUndefined())
    expect(databaseContext.getStore()?.kind).toBe('request')
  })
})
