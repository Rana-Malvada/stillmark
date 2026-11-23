/** Loopback fault injection only. Exposed by a secret-gated route in the isolated
 * build, never registered as a production route. Uses the deployed app helpers. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import snowflake from 'snowflake-sdk'
import {
  discardRoleConnection,
  SnowflakeQueryTimeoutError,
  withSnowflakeQueryDeadline,
} from '../../lib/snowflake/snowflake-query-deadline'
import { useConnectionWithDeadline } from '../../lib/connection-deadline'

export async function probeQueryDeadline() {
  assert.equal(process.env.PG_DATABASE, 'stillmark_loadtest_baseline')
  let mode: 'headers' | 'backoff' | 'healthy' = 'headers'
  let requests = 0
  let closed = 0
  let logins = 0
  let logouts = 0
  const server = createServer((req, res) => {
    req.resume()
    const reply = (data: object) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ success: true, data }))
    }
    if (req.url!.startsWith('/session/v1/login-request')) {
      logins++
      return reply({
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
      return
    } // deliberate stalled logout
    if (req.url!.startsWith('/telemetry/')) return reply({})
    requests++
    if (mode === 'headers') {
      res.once('close', () => closed++)
      return
    }
    if (mode === 'backoff') {
      res.writeHead(503)
      res.end()
      return
    }
    reply({
      queryId: 'fixture-query',
      version: 1,
      statementTypeId: 0x1000,
      total: 1,
      returned: 1,
      rowtype: [{ name: 'IS_ADMIN', type: 'boolean', nullable: false }],
      rowset: [['false']],
      parameters: [],
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const pool = snowflake.createPool(
    {
      account: 'synthetic',
      authenticator: 'OAUTH',
      token: 'synthetic',
      timeout: 5000,
      sfRetryMaxLoginRetries: 0,
      accessUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    },
    { min: 0, max: 1 },
  )
  const managed = {
    acquire: () => pool.acquire(),
    release: (c: snowflake.Connection) => pool.release(c),
    destroy: (c: snowflake.Connection) => discardRoleConnection(c, (x) => pool.destroy(x)),
  }
  const query = () =>
    useConnectionWithDeadline(
      managed,
      (conn) =>
        withSnowflakeQueryDeadline(
          200,
          () =>
            new Promise<unknown>((resolve, reject) =>
              conn.execute({
                sqlText: 'SELECT FALSE AS IS_ADMIN',
                complete: (error, _stmt, rows) => (error ? reject(error) : resolve(rows)),
              }),
            ),
        ),
      3000,
    )
  const outcomes = []
  try {
    for (const scenario of ['headers', 'backoff'] as const) {
      mode = scenario
      const before = requests
      const start = performance.now()
      await assert.rejects(query(), SnowflakeQueryTimeoutError)
      const elapsedMs = Math.round(performance.now() - start)
      assert.ok(elapsedMs < 4000, 'deadline and bounded cleanup exceeded budget')
      await new Promise((resolve) => setTimeout(resolve, 1200))
      assert.equal(requests - before, 1, 'query retried after cancellation')
      outcomes.push({ scenario, elapsedMs, queryAttempts: requests - before })
    }
    mode = 'healthy'
    assert.deepEqual(await query(), [{ IS_ADMIN: false }])
    assert.equal(closed, 1)
    assert.equal(logins, 3)
    assert.equal(logouts, 2)
    const last = await pool.acquire()
    await discardRoleConnection(last, (c) => pool.destroy(c))
    await pool.drain()
    await pool.clear()
    assert.equal(pool.size, 0)
    assert.equal(pool.borrowed, 0)
    return { passed: true, outcomes, recovery: true, logins, logouts, poolSize: pool.size }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
