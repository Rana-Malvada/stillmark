import pg from 'pg'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

export function monitorConfig(env = process.env) {
  if (!/^stillmark_loadtest_[a-z0-9_]+$/.test(env.PGDATABASE ?? ''))
    throw new Error('Isolated test database required')
  if (env.PGSSLMODE !== 'verify-full' || !env.PGSSLROOTCERT)
    throw new Error('Verified database TLS required')
  if (!env.PGHOST || !env.PGUSER || (env.PGPORT && env.PGPORT !== '5432'))
    throw new Error('Explicit direct test database connection required')
  return {
    host: env.PGHOST,
    port: Number(env.PGPORT || 5432),
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    ssl: { rejectUnauthorized: true, ca: readFileSync(env.PGSSLROOTCERT, 'utf8') },
    connectionTimeoutMillis: 10000,
    statement_timeout: 10000,
    query_timeout: 15000,
    options: '-c default_transaction_read_only=on',
    application_name: 'isolated-load-monitor',
  }
}
export function databaseMonitor(client, sql) {
  let ready
  let failure
  client.on('error', (error) => {
    failure = error
  })
  return {
    async snapshot() {
      if (failure) throw failure
      await (ready ??= client.connect())
      if (failure) throw failure
      const result = await client.query(sql)
      return Object.values(result.rows[0])[0]
    },
    async close() {
      await client.end()
    },
  }
}
async function main() {
  const sql = readFileSync(new URL('./database-sample.sql', import.meta.url), 'utf8')
  const monitor = databaseMonitor(new pg.Client(monitorConfig()), sql)
  const input = createInterface({ input: process.stdin })
  try {
    for await (const line of input) {
      if (line !== 'snapshot') throw new Error('Invalid monitor command')
      try {
        process.stdout.write(JSON.stringify({ snapshot: await monitor.snapshot() }) + '\n')
      } catch (error) {
        process.stdout.write(
          JSON.stringify({
            error: 'database_monitor_failed',
            code: /^[A-Z0-9_]{1,32}$/.test(error.code ?? '') ? error.code : 'UNKNOWN',
          }) + '\n',
        )
        process.exitCode = 1
        break
      }
    }
  } finally {
    await monitor.close()
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('Isolated database monitor failed')
    process.exitCode = 1
  })
