import { withAnonymousDatabase, withPublicDatabase } from '@/lib/database/database-context'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ clients: [] as any[], end: vi.fn() }))
vi.mock('pg', async () => ({
  default: {
    escapeLiteral: (await vi.importActual<typeof import('pg')>('pg')).default.escapeLiteral,
    Pool: class {
      on() {}
      end = state.end
      async connect() {
        const client = {
          query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] })),
          release: vi.fn(),
        }
        state.clients.push(client)
        return client
      }
    },
  },
}))
import { closePool, pgQuery, pgReadIdentity, pgTransaction } from '@/lib/postgres'

afterEach(async () => {
  await closePool()
  state.clients = []
  vi.unstubAllEnvs()
})
it('keeps concurrent verified identities on different transaction connections', async () => {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_SSL', 'false')
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const first = pgReadIdentity({ username: 'ALICE', mainAdmin: false }, async () => {
    await gate
    await pgQuery('SELECT alice')
  })
  await pgReadIdentity({ username: 'BOB', mainAdmin: false }, async () => {
    await pgQuery('SELECT bob')
  })
  release()
  await first
  const a = state.clients.find((c) => c.query.mock.calls.some((q: any) => q[1]?.[0] === 'ALICE'))
  const b = state.clients.find((c) => c.query.mock.calls.some((q: any) => q[1]?.[0] === 'BOB'))
  expect(a.query.mock.calls.map((q: any) => q[0])).toContain('SELECT alice')
  expect(a.query.mock.calls.map((q: any) => q[0])).not.toContain('SELECT bob')
  expect(b.query.mock.calls.map((q: any) => q[0])).toContain('SELECT bob')
  for (const c of [a, b]) {
    expect(c.query.mock.calls[0][0]).toBe('BEGIN READ ONLY; SET LOCAL ROLE personal_photos_reader')
    expect(c.query.mock.calls[1][1]).toEqual([c === a ? 'ALICE' : 'BOB', 'false'])
    expect(c.query.mock.calls.at(-1)[0]).toBe('COMMIT')
    expect(c.release).toHaveBeenCalledWith(false)
  }
})
it('destroys the connection if rollback fails instead of returning an unknown identity to the pool', async () => {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_SSL', 'false')
  await expect(
    pgReadIdentity({ username: 'ALICE', mainAdmin: false }, async () => {
      state.clients[0].query.mockRejectedValueOnce(new Error('rollback connection lost'))
      throw new Error('query failed')
    }),
  ).rejects.toThrow('query failed')
  expect(state.clients[0].release).toHaveBeenCalledWith(true)
})
it('batches optional OLTP planning setup with the read transaction without changing identity binding', async () => {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_SSL', 'false')
  await pgReadIdentity(
    { username: 'ALICE', mainAdmin: false },
    () => pgQuery('SELECT album_page'),
    { disableJit: true },
  )
  const calls = state.clients[0].query.mock.calls
  expect(calls.map((q: any) => q[0])).toEqual([
    'BEGIN READ ONLY; SET LOCAL ROLE personal_photos_reader; SET LOCAL jit=off',
    "SELECT set_config('photos.username',$1,true),set_config('photos.main_admin',$2,true)",
    'SELECT album_page',
    'COMMIT',
  ])
  expect(calls[1][1]).toEqual(['ALICE', 'false'])
})

it('batches the read identity without leaking it across concurrent requests', async () => {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_SSL', 'false')
  vi.stubEnv('PG_BATCH_TRANSACTION_START_ENABLED', 'true')
  await Promise.all(
    ['ALICE', "BOB'\\"].map((username) =>
      pgReadIdentity({ username, mainAdmin: false }, () => pgQuery('SELECT $1', [username])),
    ),
  )
  expect(state.clients).toHaveLength(2)
  for (const c of state.clients) {
    expect(c.query.mock.calls).toHaveLength(3)
    expect(c.query.mock.calls[0][0]).toMatch(
      /^BEGIN READ ONLY; SET LOCAL ROLE personal_photos_reader; SELECT set_config/,
    )
    expect(c.query.mock.calls[1][0]).toBe('SELECT $1')
    expect(c.query.mock.calls[2][0]).toBe('COMMIT')
    expect(c.release).toHaveBeenCalledWith(false)
  }
})

it('batches public and anonymous security contexts without reusing prior privileges', async () => {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_SSL', 'false')
  vi.stubEnv('PG_BATCH_TRANSACTION_START_ENABLED', 'true')
  await withPublicDatabase('a'.repeat(64), () => pgTransaction(() => pgQuery('SELECT public_read')))
  await withAnonymousDatabase(() => pgTransaction(() => pgQuery('SELECT anonymous_read')))
  expect(state.clients[0].query.mock.calls[0][0]).toContain(
    "set_config('photos.public_hash','" + 'a'.repeat(64) + "',true)",
  )
  expect(state.clients[1].query.mock.calls[0][0]).toContain(
    "set_config('photos.public_hash','',true)",
  )
  for (const c of state.clients) {
    expect(c.query.mock.calls).toHaveLength(3)
    expect(c.query.mock.calls[0][0]).toContain("set_config('photos.admin_read','false',true)")
    expect(c.query.mock.calls.at(-1)[0]).toBe('COMMIT')
  }
})
it('rolls back batched setup when the protected operation fails', async () => {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_SSL', 'false')
  vi.stubEnv('PG_BATCH_TRANSACTION_START_ENABLED', 'true')
  await expect(
    withAnonymousDatabase(() =>
      pgTransaction(async () => {
        throw Error('failed operation')
      }),
    ),
  ).rejects.toThrow('failed operation')
  expect(state.clients[0].query.mock.calls.at(-1)[0]).toBe('ROLLBACK')
  expect(state.clients[0].release).toHaveBeenCalledWith(false)
})

it.each([false, true])(
  'records transaction boundaries without SQL or identity (rollback=%s)',
  async (fail) => {
    vi.stubEnv('PG_HOST', 'test')
    vi.stubEnv('PG_USER', 'personal_photos_app')
    vi.stubEnv('PG_SSL', 'false')
    vi.stubEnv('PG_BATCH_TRANSACTION_START_ENABLED', 'true')
    vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
    vi.stubEnv('PG_DATABASE', 'stillmark_loadtest_transactions')
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const { traceUploadRequest } = await import('@/lib/upload/upload-request-trace')
    const error = new Error('private-query-failure')
    try {
      const result = traceUploadRequest(async () => {
        await pgReadIdentity({ username: 'PRIVATE_USER', mainAdmin: false }, async () => {
          await pgQuery('SELECT private_column')
          if (fail) throw error
        })
        return Response.json({ ok: true })
      })(
        new Request('https://test.invalid/api/events', {
          headers: { 'x-load-test-request': '00000000-0000-4000-8000-000000000000' },
        }),
      )
      if (fail) await expect(result).rejects.toBe(error)
      else expect((await result).status).toBe(200)
      const logs = out.mock.calls.map((c) => String(c[0])).join('')
      expect(logs).toContain('db-transaction-start')
      expect(logs).toContain(fail ? 'db-transaction-rollback' : 'db-transaction-commit')
      expect(logs).not.toMatch(/PRIVATE_USER|private_column|private-query-failure/)
      expect(state.clients[0].release).toHaveBeenCalledWith(false)
    } finally {
      out.mockRestore()
    }
  },
)

it('single-query reads use one checked-out connection and one protocol exchange', async () => {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_SSL', 'false')
  const result = await pgReadIdentity(
    { username: 'ALICE', mainAdmin: false },
    async () => {
      // Mock the wire result, not the identity wrapper.
      const promise = pgQuery('SELECT $1 AS value', [7])
      await Promise.resolve()
      const client = state.clients[0]
      // checkout yields before executing the actual wire query.
      client.query.mockResolvedValue([
        { rows: [], command: 'BEGIN' },
        { rows: [], command: 'SET' },
        { rows: [], command: 'SELECT' },
        { rows: [{ value: 7 }], command: 'SELECT' },
        { rows: [], command: 'COMMIT' },
      ])
      return promise
    },
    { singleQuery: true },
  )
  expect(result).toEqual([{ value: 7 }])
  expect(state.clients).toHaveLength(1)
  expect(state.clients[0].query).toHaveBeenCalledTimes(1)
  expect(state.clients[0].query.mock.calls[0][0]).toContain('SELECT 7 AS value; COMMIT;')
  expect(state.clients[0].release).toHaveBeenCalledWith(false)
})

it.each([false, true])(
  'single-query read rolls back a failed exchange, destroying the client when rollback fails=%s',
  async (rollbackFails) => {
    vi.stubEnv('PG_HOST', 'test')
    vi.stubEnv('PG_USER', 'personal_photos_app')
    vi.stubEnv('PG_SSL', 'false')
    await expect(
      pgReadIdentity(
        { username: 'ALICE', mainAdmin: false },
        async () => {
          const result = pgQuery('SELECT 1')
          await Promise.resolve()
          const q = state.clients[0].query
          q.mockRejectedValueOnce(Error('wire failed'))
          if (rollbackFails) q.mockRejectedValueOnce(Error('rollback failed'))
          return result
        },
        { singleQuery: true },
      ),
    ).rejects.toThrow('wire failed')
    expect(state.clients[0].query.mock.calls.at(-1)[0]).toBe('ROLLBACK')
    expect(state.clients[0].release).toHaveBeenCalledWith(rollbackFails)
  },
)
it('single-query scope rejects a second read instead of silently opening an unscoped connection', async () => {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_SSL', 'false')
  await expect(
    pgReadIdentity(
      { username: 'ALICE', mainAdmin: false },
      async () => {
        const first = pgQuery('SELECT 1')
        await Promise.resolve()
        state.clients[0].query.mockResolvedValue([
          { rows: [], command: 'SELECT' },
          { rows: [], command: 'COMMIT' },
        ])
        await first
        return pgQuery('SELECT 2')
      },
      { singleQuery: true },
    ),
  ).rejects.toThrow('exactly one query')
  expect(state.clients).toHaveLength(1)
})
