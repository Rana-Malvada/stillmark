import { afterEach, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import snowflake from 'snowflake-sdk'
import {
  discardRoleConnection,
  SnowflakeQueryTimeoutError,
  withSnowflakeQueryDeadline,
} from '@/lib/snowflake/snowflake-query-deadline'
import { useConnectionWithDeadline } from '@/lib/connection-deadline'

snowflake.configure({ logLevel: 'OFF' })
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function reply(res: ServerResponse, data: object, code?: string) {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ success: true, ...(code ? { code } : {}), data }))
}
function result(res: ServerResponse) {
  reply(res, {
    queryId: 'fixture-query',
    version: 1,
    statementTypeId: 0x1000,
    total: 1,
    returned: 1,
    rowtype: [{ name: 'IS_ADMIN', type: 'boolean', nullable: false }],
    rowset: [['false']],
    parameters: [],
  })
}
async function fixture(
  query: (req: IncomingMessage, res: ServerResponse) => void,
  stallLogout = false,
) {
  let logins = 0
  let logouts = 0
  const server = createServer((req, res) => {
    req.resume()
    if (req.url!.startsWith('/session/v1/login-request')) {
      logins++
      return reply(res, {
        token: 'synthetic',
        masterToken: 'synthetic',
        sessionId: logins,
        validityInSeconds: 3600,
        masterValidityInSeconds: 3600,
        parameters: [],
        sessionInfo: {
          databaseName: 'TEST',
          schemaName: 'PUBLIC',
          roleName: 'PUBLIC',
          warehouseName: null,
        },
      })
    }
    if (req.url!.startsWith('/session?')) {
      logouts++
      if (!stallLogout) reply(res, {})
      return
    }
    if (req.url!.startsWith('/telemetry/')) return reply(res, {})
    query(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const config = {
    account: 'synthetic',
    authenticator: 'OAUTH',
    token: 'synthetic',
    timeout: 5000,
    sfRetryMaxLoginRetries: 0,
    accessUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  }
  return { config, logins: () => logins, logouts: () => logouts }
}
async function connect(config: snowflake.ConnectionOptions) {
  const conn = snowflake.createConnection(config)
  await new Promise<void>((resolve, reject) =>
    conn.connect((error) => (error ? reject(error) : resolve())),
  )
  return conn
}
function execute(conn: snowflake.Connection) {
  return new Promise<unknown>((resolve, reject) =>
    conn.execute({
      sqlText: 'SELECT FALSE AS IS_ADMIN',
      complete: (error, _stmt, rows) => (error ? reject(error) : resolve(rows)),
    }),
  )
}

it.each(['headers', 'backoff', 'result-poll'] as const)(
  'aborts %s and leaves no retry running',
  async (mode) => {
    let requests = 0
    let closed = 0
    const f = await fixture((req, res) => {
      requests++
      if (mode === 'backoff') {
        res.writeHead(503)
        res.end()
        return
      }
      if (mode === 'result-poll' && req.url!.startsWith('/queries/v1/')) {
        return reply(
          res,
          { queryId: 'fixture-query', getResultUrl: '/queries/fixture-query/result' },
          '333333',
        )
      }
      res.once('close', () => closed++)
    })
    const conn = await connect(f.config)
    const start = performance.now()
    await expect(withSnowflakeQueryDeadline(150, () => execute(conn))).rejects.toBeInstanceOf(
      SnowflakeQueryTimeoutError,
    )
    expect(performance.now() - start).toBeLessThan(1500)
    await pause(50) // socket close notification follows request abort
    if (mode !== 'backoff') expect(closed).toBe(1)
    const observed = requests
    await pause(1200) // exceed the SDK's minimum first retry delay
    expect(requests).toBe(observed)
    expect(requests).toBe(mode === 'result-poll' ? 2 : 1)
  },
  6000,
)

it('isolates concurrent calls and clears the deadline after successful work', async () => {
  const f = await fixture((req, res) => {
    if (req.headers['authorization']) setTimeout(() => result(res), 300)
  })
  const a = await connect(f.config)
  const b = await connect(f.config)
  const failed = expect(withSnowflakeQueryDeadline(100, () => execute(a))).rejects.toBeInstanceOf(
    SnowflakeQueryTimeoutError,
  )
  const ordinary = execute(b)
  await failed
  await expect(ordinary).resolves.toEqual([{ IS_ADMIN: false }])
  await expect(withSnowflakeQueryDeadline(1000, () => execute(b))).resolves.toEqual([
    { IS_ADMIN: false },
  ])
  await pause(1100)
  await expect(execute(b)).resolves.toEqual([{ IS_ADMIN: false }])
}, 6000)

it('discards a timed-out pooled connection, bounds stalled logout, and admits a waiting caller', async () => {
  let healthy = false
  let requests = 0
  const f = await fixture((_req, res) => {
    requests++
    if (healthy) result(res)
  }, true)
  const pool = snowflake.createPool(f.config, { min: 0, max: 1, acquireTimeoutMillis: 5000 })
  const managed = {
    acquire: () => pool.acquire(),
    release: (c: snowflake.Connection) => pool.release(c),
    destroy: (c: snowflake.Connection) => discardRoleConnection(c, (x) => pool.destroy(x)),
  }
  const start = performance.now()
  const first = useConnectionWithDeadline(
    managed,
    (c) => withSnowflakeQueryDeadline(150, () => execute(c)),
    2000,
  )
  const failed = expect(first).rejects.toBeInstanceOf(SnowflakeQueryTimeoutError)
  await pause(300)
  healthy = true
  const second = useConnectionWithDeadline(
    managed,
    (c) => withSnowflakeQueryDeadline(1000, () => execute(c)),
    4000,
  )
  await failed
  await expect(second).resolves.toEqual([{ IS_ADMIN: false }])
  expect(performance.now() - start).toBeLessThan(4000)
  expect(f.logins()).toBe(2)
  expect(f.logouts()).toBe(1)
  expect(requests).toBe(2)
  const last = await pool.acquire()
  await discardRoleConnection(last, (c) => pool.destroy(c))
  await pool.drain()
  await pool.clear()
  expect(pool.borrowed).toBe(0)
  expect(pool.size).toBe(0)
}, 9000)
