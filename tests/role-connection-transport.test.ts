import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import snowflake from 'snowflake-sdk'
import { acquireRoleConnection } from '@/lib/role-connection'

it.each(['stall', 'unavailable', 'persistent-unavailable'] as const)(
  'handles %s during SDK login without submitting SQL',
  async (failure) => {
    snowflake.configure({ logLevel: 'OFF' })
    let logins = 0
    let queries = 0
    let firstClosed = false
    const server = createServer((req, res) => {
      req.resume()
      const reply = (data: object) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ success: true, data }))
      }
      if (req.url!.startsWith('/session/v1/login-request')) {
        logins++
        if (failure === 'persistent-unavailable' || (failure === 'unavailable' && logins === 1)) {
          res.writeHead(503)
          res.end('Service unavailable')
          return
        }
        if (failure === 'stall' && logins === 1) {
          res.on('close', () => {
            firstClosed = true
          })
          return
        }
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
      if (req.url!.startsWith('/queries/')) queries++
      reply({})
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
      { min: 0, max: 2, acquireTimeoutMillis: 5000 },
    )
    try {
      const started = performance.now()
      if (failure === 'persistent-unavailable') {
        await expect(acquireRoleConnection(pool)).rejects.toMatchObject({
          code: 401002,
          snowflakeHttpStatus: 503,
        })
        expect(logins).toBe(2)
        expect(queries).toBe(0)
        expect(performance.now() - started).toBeLessThan(4500)
        return
      }
      const conn = await acquireRoleConnection(pool)
      expect(performance.now() - started).toBeLessThan(4500)
      expect(logins).toBe(2)
      if (failure === 'stall') expect(firstClosed).toBe(true)
      expect(queries).toBe(0)
      await pool.release(conn)
    } finally {
      await pool.drain()
      await pool.clear()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
  12000,
)
