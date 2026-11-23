import pg from 'pg'
import { postgresPoolMax } from '../database/postgres-pool-budget'
import { readFileSync } from 'node:fs'

let pool: pg.Pool | undefined
/** Separate restricted credential: can dispatch uploads, not read the catalog or
 * mutate routing. Never fall back to the maintenance/admin credential. */
export function uploadQueuePool() {
  if (pool) return pool
  let password = process.env.PG_UPLOAD_QUEUE_PASSWORD
  try {
    password = readFileSync('/secrets/PG_UPLOAD_QUEUE/password', 'utf8').trim()
  } catch {}
  if (!password || !process.env.PG_HOST)
    throw new Error('Upload queue credential or host unavailable')
  pool = new pg.Pool({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT ?? 5432),
    database: process.env.PG_DATABASE ?? 'postgres',
    user: 'personal_photos_upload_queue',
    password,
    ssl: {
      rejectUnauthorized: true,
      ca: readFileSync(process.env.PG_SSL_ROOT_CERT ?? 'certs/postgres-root.crt', 'utf8'),
    },
    max: postgresPoolMax('queue'),
    statement_timeout: 15000,
    query_timeout: 20000,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  })
  pool.on('error', () => console.error('[upload-queue] Database connection failed'))
  return pool
}
