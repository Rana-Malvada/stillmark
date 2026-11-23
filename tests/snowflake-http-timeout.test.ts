import { expect, it } from 'vitest'
import { Agent, createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// Exercise the locked SDK's actual HTTP transport, not a mocked execute callback.
// Internal imports are test-only; production uses supported connection options.
const require = createRequire(import.meta.url)
const sdkRoot = dirname(require.resolve('snowflake-sdk'))
const snowflake = require('snowflake-sdk')
const HttpClient = require(join(sdkRoot, 'lib/http/base.js'))
const ConnectionConfig = require(join(sdkRoot, 'lib/connection/connection_config.js'))

it('closes a stalled HTTP attempt and recovers through the SDK retry transport', async () => {
  snowflake.configure({ logLevel: 'OFF' })
  let attempts = 0
  let stalledConnectionClosed = false
  const server = createServer((req, res) => {
    req.resume()
    attempts++
    if (attempts === 1) {
      res.once('close', () => {
        stalledConnectionClosed = true
      })
      return // Deliberately never send headers for the first attempt.
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const agent = new Agent()
  try {
    const config = new ConnectionConfig({
      account: 'synthetic',
      authenticator: 'OAUTH',
      token: 'synthetic',
      accessUrl: `http://127.0.0.1:${port}`,
      timeout: 100,
      sfRetryMaxLoginRetries: 0,
    })
    expect(config.getTimeout()).toBe(100)
    expect(config.getRetrySfMaxLoginRetries()).toBe(0)
    const client = new HttpClient(config)
    // Local HTTP fixture only; do not change production TLS verification or agents.
    client.getAgent = () => agent
    const response = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      client.request({
        method: 'POST',
        url: config.accessUrl + '/queries/v1/query-request',
        useSnowflakeRetryMiddleware: true,
        // Bound this test and remove random backoff. Production retry behavior is unchanged.
        snowflakeRetryConfig: { maxRetries: 1, sleepBase: 0, sleepCap: 0 },
        callback: (error: Error | null, result: { statusCode: number }, body: unknown) => {
          if (error) reject(error)
          else resolve({ status: result.statusCode, body })
        },
      })
    })
    expect(response).toEqual({ status: 200, body: { ok: true } })
    expect(attempts).toBe(2)
    expect(stalledConnectionClosed).toBe(true)
  } finally {
    agent.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  }
}, 10_000)

it('bounds connection setup before any HTTP request reaches the server', async () => {
  let lookups = 0
  let received = 0
  const server = createServer((req, res) => {
    received++
    req.resume()
    res.setHeader('Content-Type', 'application/json')
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const agent = new Agent({
    lookup: (_hostname, options, callback) => {
      lookups++
      if (lookups === 1) return // Deliberately never complete the first connection setup.
      if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }])
      else callback(null, '127.0.0.1', 4)
    },
  })
  try {
    const config = new ConnectionConfig({
      account: 'synthetic',
      authenticator: 'OAUTH',
      token: 'synthetic',
      accessUrl: `http://fixture.invalid:${port}`,
      timeout: 100,
    })
    const client = new HttpClient(config)
    client.getAgent = () => agent
    const status = await new Promise<number>((resolve, reject) =>
      client.request({
        method: 'POST',
        url: config.accessUrl + '/queries/v1/query-request',
        useSnowflakeRetryMiddleware: true,
        snowflakeRetryConfig: { maxRetries: 1, sleepBase: 0, sleepCap: 0 },
        callback: (error: Error | null, response: { statusCode: number }) =>
          error ? reject(error) : resolve(response.statusCode),
      }),
    )
    expect(status).toBe(200)
    expect(lookups).toBe(2)
    expect(received).toBe(1)
  } finally {
    agent.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  }
}, 10_000)

it('does not keep retrying a failed authorization login after its timeout', async () => {
  snowflake.configure({ logLevel: 'OFF' })
  let requests = 0
  let closed = 0
  const server = createServer((req, res) => {
    requests++
    req.resume()
    res.once('close', () => closed++)
    // Deliberate persistent outage: never answer the login request.
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const connection = snowflake.createConnection({
      account: 'synthetic',
      authenticator: 'OAUTH',
      token: 'synthetic',
      accessUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      timeout: 100,
      sfRetryMaxLoginRetries: 0,
    })
    const error = await new Promise<Error | undefined>((resolve) => connection.connect(resolve))
    expect(error).toBeTruthy()
    // Observe beyond the attempt deadline: no hidden login retry may start.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(requests).toBe(1)
    expect(closed).toBe(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  }
}, 10_000)

it('removes expired pool borrowers so a login outage does not keep creating connections', async () => {
  let requests = 0
  const server = createServer((req) => {
    requests++
    req.resume()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const pool = snowflake.createPool(
    {
      account: 'synthetic',
      authenticator: 'OAUTH',
      token: 'synthetic',
      timeout: 100,
      sfRetryMaxLoginRetries: 0,
      accessUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    },
    { min: 0, max: 1, acquireTimeoutMillis: 50 },
  )
  try {
    await expect(pool.acquire()).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(requests).toBe(1)
    expect(pool.pending).toBe(0)
    expect(pool.size).toBe(0)
    await pool.drain()
    await pool.clear()
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
