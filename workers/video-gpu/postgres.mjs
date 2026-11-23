// Dedicated worker connection: retains its scoped database role and verified TLS.
import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'
import { readFileSync } from 'fs'

var pool = null
var transaction = new AsyncLocalStorage()
/**
 * The worker connects only as its own scoped database role, named explicitly by its
 * job specification. It never reads a local service definition and never defaults to
 * an administrator identity: missing configuration stops the worker.
 */
function getPool() {
  if (pool) return pool
  const { PG_HOST: host, PG_USER: user } = process.env
  if (!host || !user) throw new Error('PG_HOST and PG_USER are required')
  let password = process.env.PG_PASSWORD
  try {
    password = readFileSync('/secrets/PG_SECRET/password', 'utf-8').trim()
  } catch {
    // No mounted secret: use PG_PASSWORD, which is how local runs supply it.
  }
  if (!password) throw new Error('Database credential unavailable')
  console.log('[pg] Connecting to', host, 'port', process.env.PG_PORT, 'user', user)
  pool = new pg.Pool({
    host,
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'postgres',
    user,
    password,
    ssl:
      process.env.PG_SSL === 'false' && process.env.NODE_ENV !== 'production'
        ? false
        : {
            rejectUnauthorized: true,
            ...(process.env.PG_SSL_ROOT_CERT
              ? { ca: readFileSync(process.env.PG_SSL_ROOT_CERT, 'utf8') }
              : {}),
          },
    max: 10,
    statement_timeout: 3e4,
    query_timeout: 35e3,
    idleTimeoutMillis: 3e4,
    connectionTimeoutMillis: 1e4,
  })
  pool.on('error', (error) => console.error('[postgres-pool]', error.message))
  return pool
}
async function pgQuery(sql, params) {
  const p = transaction.getStore() ?? getPool()
  const result = await p.query(sql, params)
  return result.rows
}
async function pgQueryOne(sql, params) {
  const rows = await pgQuery(sql, params)
  return rows.length > 0 ? rows[0] : null
}
async function pgTransaction(fn) {
  if (transaction.getStore()) return fn()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await transaction.run(client, fn)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export { pgQuery, pgQueryOne, pgTransaction }
