import { scopedReadStatement } from './postgres-scoped-read.mjs'
import { databaseClientLifetime } from './database/postgres-client-lifetime'
import {
  readTransactionStart,
  requestTransactionStart,
} from './database/postgres-transaction-start'
import { acquireDatabaseClient } from './database/postgres-admission'
import { gatewayMediaBootstrapSql, gatewayMediaPath } from './identity/gateway-media-bootstrap'
import { postgresPermissionsEnabled } from './permission-authority'
import type { AppPermissionIdentity } from './app-permissions'
import { uploadRequestStep } from './upload/upload-request-trace'
import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'
import { recordPerformance } from './observability/performance-metrics'
import { postgresAppMemoryOptions } from './database/postgres-memory'
import { postgresPoolMax } from './database/postgres-pool-budget'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { databaseContext, type DatabaseIdentity, databaseSignal } from './database/database-context'
import { flagOn } from './flags'
import { logError, logInfo } from './log'

let pool: pg.Pool | null = null
let servicePool: pg.Pool | null = null
const transaction = new AsyncLocalStorage<pg.PoolClient>()
const independentScope = new AsyncLocalStorage<boolean>()
const singleReadScope = new AsyncLocalStorage<{
  identity: { username: string; mainAdmin: boolean }
  disableJit: boolean
  used: boolean
}>()
const independentPools = new Map<boolean, pg.Pool>()
const sessionPools = new Map<boolean, pg.Pool>()
function directPort(fallback?: number): number | undefined {
  const configured = process.env.PG_DIRECT_PORT
  if (configured === undefined) return fallback
  if (!/^[0-9]+$/.test(configured) || Number(configured) < 1 || Number(configured) > 65535)
    throw new Error('PG_DIRECT_PORT must be a valid TCP port')
  return Number(configured)
}
const serviceConnections = new WeakSet<pg.PoolClient>()

/** Server-side limit on one statement. */
const STATEMENT_TIMEOUT_MS = 30_000
/** Client-side limit on one query; longer, so the server's own timeout normally reports first. */
const QUERY_TIMEOUT_MS = 35_000
const IDLE_TIMEOUT_MS = 30_000
const CONNECTION_TIMEOUT_MS = 10_000

/** Settings every base pool shares; `connection` holds what genuinely differs.
 * The local development pool has never set a connection timeout. */
function poolOptions(
  kind: 'app' | 'maintenance',
  connection: pg.PoolConfig,
  connectionTimeout = true,
): pg.PoolConfig {
  return {
    ...connection,
    max: postgresPoolMax(kind),
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    ...(connectionTimeout ? { connectionTimeoutMillis: CONNECTION_TIMEOUT_MS } : {}),
  }
}
/** Same credential and TLS policy as `base` on a direct port, with separate small capacity. */
function directPoolOptions(base: pg.PoolConfig, port: number | undefined): pg.PoolConfig {
  // pg-pool deliberately makes password non-enumerable; spread alone drops it.
  return { ...base, password: base.password, port, max: postgresPoolMax('independent') }
}
function createPool(options: pg.PoolConfig): pg.Pool {
  const created = new pg.Pool(options)
  created.on('error', (error) => logError('postgres-pool', error))
  return created
}

interface ServiceEntry {
  host: string
  port: string
  dbname: string
  user: string
  sslmode?: string
  sslrootcert?: string
}

function requireAppUser(user: string | undefined): string {
  if (user !== 'personal_photos_app') {
    throw new Error(
      'Application database user must be explicitly configured as personal_photos_app; administrator credentials are not permitted',
    )
  }
  return user
}

function parseServiceFile(serviceName: string): ServiceEntry | null {
  const path = join(homedir(), '.pg_service.conf')
  if (!existsSync(path)) return null

  const content = readFileSync(path, 'utf-8')
  const lines = content.split('\n')
  let inSection = false
  const entry: Record<string, string> = {}

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith(`[${serviceName}]`)) {
      inSection = true
      continue
    }
    if (line.startsWith('[') && inSection) break
    if (inSection && line.includes('=')) {
      const eq = line.indexOf('=')
      entry[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
  }

  if (!entry.host) return null
  return {
    host: entry.host,
    port: entry.port || '5432',
    dbname: entry.dbname || 'postgres',
    user: entry.user || '',
    sslmode: entry.sslmode,
    sslrootcert: entry.sslrootcert,
  }
}

function parsePgpass(host: string, port: string, dbname: string, user: string): string | null {
  const path = join(homedir(), '.pgpass')
  if (!existsSync(path)) return null

  const lines = readFileSync(path, 'utf-8').split('\n')
  for (const line of lines) {
    if (line.startsWith('#') || !line.trim()) continue
    const parts = line.split(':')
    if (parts.length < 5) continue
    const [h, p, d, u, ...pw] = parts
    const matches = (v: string, target: string) => v === '*' || v === target
    if (matches(h, host) && matches(p, port) && matches(d, dbname) && matches(u, user)) {
      return pw.join(':')
    }
  }
  return null
}

function getPool(service = false): pg.Pool {
  if (service) {
    if (servicePool) return servicePool
    const svc = parseServiceFile('personal_media_pg')
    let password = process.env.PG_MAINTENANCE_PASSWORD
    try {
      password = readFileSync('/secrets/PG_MAINTENANCE/password', 'utf8').trim()
    } catch {
      // No mounted secret file: keep PG_MAINTENANCE_PASSWORD; a missing credential fails just below.
    }
    if (!password) throw new Error('Maintenance database credential unavailable')
    servicePool = createPool(
      poolOptions('maintenance', {
        host: process.env.PG_HOST ?? svc?.host,
        port: directPort(Number(process.env.PG_PORT ?? svc?.port ?? 5432)),
        database: process.env.PG_DATABASE ?? svc?.dbname ?? 'postgres',
        user: 'personal_photos_maintenance',
        password,
        ssl: {
          rejectUnauthorized: true,
          ca: readFileSync(
            process.env.PG_SSL_ROOT_CERT ?? svc?.sslrootcert ?? 'certs/postgres-root.crt',
            'utf8',
          ),
        },
      }),
    )
    return servicePool
  }
  if (pool) return pool

  // Option 1: explicit env vars (for SPCS/SAR deployment)
  if (process.env.PG_HOST) {
    // SAR mounts PASSWORD secrets as files under /secrets/<name>/
    let password = process.env.PG_PASSWORD
    try {
      password = readFileSync('/secrets/PG_SECRET/password', 'utf-8').trim()
      logInfo('pg', 'Read password from /secrets/PG_SECRET/password')
    } catch {
      logInfo('pg', 'No secret file, using PG_PASSWORD env var:', password ? 'set' : 'unset')
    }
    logInfo(
      'pg',
      'Connecting to',
      process.env.PG_HOST,
      'port',
      process.env.PG_PORT,
      'user',
      process.env.PG_USER,
    )
    pool = createPool(
      poolOptions('app', {
        options: postgresAppMemoryOptions(),
        host: process.env.PG_HOST,
        port: parseInt(process.env.PG_PORT || '5432'),
        database: process.env.PG_DATABASE || 'postgres',
        user: requireAppUser(process.env.PG_USER),
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
      }),
    )
    return pool
  }

  // Option 2: read from ~/.pg_service.conf + ~/.pgpass (local dev)
  const svc = parseServiceFile('personal_media_pg')
  if (!svc) {
    throw new Error('No PG_HOST env var and no personal_media_pg entry in ~/.pg_service.conf')
  }

  const password = parsePgpass(svc.host, svc.port, svc.dbname, svc.user)

  const sslConfig =
    svc.sslrootcert && existsSync(svc.sslrootcert)
      ? { ca: readFileSync(svc.sslrootcert, 'utf-8'), rejectUnauthorized: true }
      : { rejectUnauthorized: true }

  pool = createPool(
    poolOptions(
      'app',
      {
        options: postgresAppMemoryOptions(),
        host: svc.host,
        port: parseInt(svc.port),
        database: svc.dbname,
        user: requireAppUser(svc.user),
        password: password ?? undefined,
        ssl: sslConfig,
      },
      false,
    ),
  )
  return pool
}

function getIndependentPool(service: boolean): pg.Pool {
  let selected = independentPools.get(service)
  if (!selected) {
    // Same credential and TLS policy, separate bounded capacity. A parent transaction
    // may hold every normal slot while waiting for this independently durable write.
    const options = getPool(service).options
    if (options.port === 5431 && directPort(options.port) === 5431)
      throw new Error('Pooled uploads require PG_DIRECT_PORT for independent durable writes')
    selected = createPool(directPoolOptions(options, directPort(options.port)))
    independentPools.set(service, selected)
  }
  return selected
}
/** Session locks must retain one physical backend; never send them through transaction pooling. */
function getSessionPool(service: boolean): pg.Pool {
  const base = getPool(service)
  const port = directPort(base.options.port)
  if (port === 5431)
    throw new Error('Session locks require PG_DIRECT_PORT with Snowflake transaction pooling')
  if (port === base.options.port) return base
  let selected = sessionPools.get(service)
  if (!selected) {
    selected = createPool(directPoolOptions(base.options, port))
    sessionPools.set(service, selected)
  }
  return selected
}
async function checkout(service = false) {
  const selected = independentScope.getStore() ? getIndependentPool(service) : getPool(service)
  const start = performance.now()
  const queued =
    selected.waitingCount ||
    (selected.totalCount >= (selected.options?.max ?? 10) && selected.idleCount === 0 ? 1 : 0)
  try {
    const client = await uploadRequestStep('db-checkout', () =>
      acquireDatabaseClient<pg.PoolClient>(selected, databaseSignal()),
    )
    recordPerformance(
      service ? 'maintenance-pool' : 'database-pool',
      performance.now() - start,
      queued,
    )
    return client
  } catch (error) {
    recordPerformance(
      service ? 'maintenance-pool' : 'database-pool',
      performance.now() - start,
      queued,
      true,
    )
    throw error
  }
}
async function bootstrapQuery(sql: string, params?: unknown[]) {
  const client = await checkout()
  const lifetime = databaseClientLifetime(client, databaseSignal())
  let broken = false
  try {
    return await uploadRequestStep('auth-bootstrap-query', () => client.query(sql, params))
  } catch (error) {
    broken = true
    throw error
  } finally {
    lifetime.release(broken)
  }
}

/** Narrow, opt-in media read. Its statement-local identity ends before release. */
export async function pgLookupMedia<T>(
  path: string,
  identity: DatabaseIdentity,
): Promise<T | null> {
  if (transaction.getStore() || databaseContext.getStore()?.kind !== 'request')
    throw new Error('Atomic media lookup requires a standalone request')
  const result = await bootstrapQuery('SELECT photo_security.lookup_media($1,$2::jsonb) AS photo', [
    path,
    JSON.stringify(identity),
  ])
  return (result.rows[0]?.photo ?? null) as T | null
}

export async function pgQuery<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const single = singleReadScope.getStore()
  if (single) {
    if (single.used || transaction.getStore())
      throw new Error('Scoped read must execute exactly one query')
    single.used = true
    const statement = scopedReadStatement(sql, params ?? [], single.identity, single.disableJit)
    const batchClient = await checkout()
    const lifetime = databaseClientLifetime(batchClient, databaseSignal())
    let broken = false
    try {
      const results = (await uploadRequestStep('db-read-batch', () =>
        batchClient.query(statement),
      )) as unknown as pg.QueryResult[]
      if (!Array.isArray(results) || results.at(-1)?.command !== 'COMMIT')
        throw new Error('Incomplete scoped read')
      return results.at(-2)!.rows as T[]
    } catch (error) {
      try {
        await batchClient.query('ROLLBACK')
      } catch {
        broken = true
      }
      throw error
    } finally {
      lifetime.release(broken)
    }
  }
  const client = transaction.getStore()
  if (client) {
    if (serviceConnections.has(client) !== (databaseContext.getStore()?.kind === 'service'))
      throw new Error('Database scope cannot change inside a transaction')
    return (await uploadRequestStep('db-query', () => client.query(sql, params))).rows as T[]
  }
  return pgTransaction(
    async () =>
      (await uploadRequestStep('db-query', () => transaction.getStore()!.query(sql, params)))
        .rows as T[],
  )
}

export async function pgQueryOne<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await pgQuery<T>(sql, params)
  return rows.length > 0 ? rows[0] : null
}

// LISTEN needs a persistent physical session. Give the elected coordinator
// one connection outside the work pools so it cannot hold an upload slot.
export function createPhotoAiListenerClient() {
  const options = getSessionPool(true).options
  return new pg.Client({
    ...options,
    password: options.password,
    application_name: 'stillmark_photo_ai_listener',
    keepAlive: true,
  })
}

export async function closePool(): Promise<void> {
  for (const selected of sessionPools.values()) await selected.end()
  sessionPools.clear()
  for (const selected of independentPools.values()) await selected.end()
  independentPools.clear()
  if (servicePool) {
    await servicePool.end()
    servicePool = null
  }
  if (pool) {
    await pool.end()
    pool = null
  }
}

export async function getDatabaseIdentity(): Promise<DatabaseIdentity> {
  const resolve = async () => {
    const { getCallerIdentity, hasAccessManagerRole } = await import('./identity/auth')
    const caller = await getCallerIdentity()
    const main = caller.mainAdmin ?? (await pgAuthMainAdmin(caller.username))
    return {
      username: caller.username,
      mainAdmin: (caller.appOwner === true || main) && caller.role !== 'admin_readonly',
      adminRead: caller.role !== 'viewer',
      adminWrite: caller.role === 'admin',
      canWrite: caller.canManagePersonal ?? caller.role !== 'admin_readonly',
      accessManager:
        (caller as typeof caller & { canManageAccess?: boolean }).canManageAccess ??
        (await hasAccessManagerRole()),
    }
  }
  const ctx = databaseContext.getStore()
  if (ctx?.kind === 'request') return (ctx.identity ??= resolve())
  return resolve()
}
async function configureIdentity(client: pg.PoolClient) {
  const ctx = databaseContext.getStore()
  if (ctx?.kind === 'service') return
  const identity =
    ctx?.kind === 'public' || ctx?.kind === 'anonymous' ? null : await getDatabaseIdentity()
  await client.query(
    `SELECT set_config('photos.username',$1,true),set_config('photos.main_admin',$2,true),
 set_config('photos.admin_read',$3,true),set_config('photos.admin_write',$4,true),set_config('photos.can_write',$5,true),
 set_config('photos.access_manager',$6,true),set_config('photos.public_hash',$7,true)`,
    [
      identity?.username ?? '',
      identity?.mainAdmin ? 'true' : 'false',
      identity?.adminRead ? 'true' : 'false',
      identity?.adminWrite ? 'true' : 'false',
      identity?.canWrite ? 'true' : 'false',
      identity?.accessManager ? 'true' : 'false',
      ctx?.kind === 'public' ? ctx.hash : '',
    ],
  )
}
/** One short transaction; the identity is discarded before returning a connection. */
export async function pgTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (transaction.getStore()) {
    if (
      serviceConnections.has(transaction.getStore()!) !==
      (databaseContext.getStore()?.kind === 'service')
    )
      throw new Error('Database scope cannot change inside a transaction')
    return fn()
  }
  // Resolve authentication before checking out a connection; bootstrap uses its own fixed queries.
  const ctx = databaseContext.getStore()
  if (!ctx || ctx.kind === 'request') await getDatabaseIdentity()
  const client = await checkout(ctx?.kind === 'service')
  if (ctx?.kind === 'service') serviceConnections.add(client)
  const lifetime = databaseClientLifetime(client, databaseSignal())
  let broken = false
  try {
    if (flagOn('PG_BATCH_TRANSACTION_START_ENABLED') && ctx?.kind !== 'service') {
      const identity =
        ctx?.kind === 'public' || ctx?.kind === 'anonymous' ? null : await getDatabaseIdentity()
      await uploadRequestStep('db-transaction-start', () =>
        client.query(requestTransactionStart(identity, ctx?.kind === 'public' ? ctx.hash : '')),
      )
    } else {
      await uploadRequestStep('db-transaction-start', async () => {
        await client.query('BEGIN')
        await configureIdentity(client)
      })
    }
    const result = await transaction.run(client, fn)
    await uploadRequestStep('db-transaction-commit', () => client.query('COMMIT'))
    return result
  } catch (error) {
    try {
      await uploadRequestStep('db-transaction-rollback', () => client.query('ROLLBACK'))
    } catch {
      broken = true
    }
    throw error
  } finally {
    lifetime.release(broken)
  }
}
/** Narrow authentication bootstrap functions; no arbitrary SQL or catalog access. */
export async function pgAuthGateway(
  subject: string,
  sid: string,
  jti: string,
  exp: number,
  startedAt?: number,
) {
  const ctx = databaseContext.getStore()
  const combinedPath =
    postgresPermissionsEnabled() &&
    flagOn('PG_MEDIA_LOOKUP_FUNCTION_ENABLED') &&
    ctx?.kind === 'request'
      ? gatewayMediaPath(ctx.requestBinding)
      : null
  const customerAccounts = flagOn('CUSTOMER_ACCOUNTS_ENABLED') && postgresPermissionsEnabled()
  const result = await bootstrapQuery(
    combinedPath
      ? customerAccounts
        ? gatewayMediaBootstrapSql.replace(
            'gateway_app_identity_once($1,$2::uuid,$3::uuid,$4)',
            'gateway_customer_identity_once($1,$2::uuid,$3::uuid,$4,$6)',
          )
        : gatewayMediaBootstrapSql
      : customerAccounts
        ? 'SELECT * FROM photo_security.gateway_customer_identity_once($1,$2::uuid,$3::uuid,$4,$5)'
        : postgresPermissionsEnabled()
          ? 'SELECT * FROM photo_security.gateway_app_identity_once($1,$2::uuid,$3::uuid,$4)'
          : 'SELECT * FROM photo_security.gateway_identity_once($1,$2::uuid,$3::uuid,$4)',
    combinedPath
      ? [subject, sid, jti, exp, combinedPath, ...(customerAccounts ? [startedAt ?? null] : [])]
      : [subject, sid, jti, exp, ...(customerAccounts ? [startedAt ?? null] : [])],
  )
  const row = result.rows[0]
  if (combinedPath && row && ctx?.kind === 'request') {
    ctx.gatewayMediaLookup = { username: row.name, path: combinedPath, row: row.prefetched_media }
    delete row.prefetched_media
  }
  return row as
    | ({
        name: string
        marker: string
        revoked: boolean
        epoch: string
      } & Partial<AppPermissionIdentity>)
    | undefined
}
/**
 * What a signed-in session may do now: the row a new sign-in would get, read without
 * consuming a gateway assertion, so a long response can ask again while it runs.
 * Undefined when the account is no longer linked or ready.
 */
export async function pgSessionAuthority(
  subject: string,
  sid: string,
  startedAt?: number,
): Promise<AppPermissionIdentity | undefined> {
  const customerAccounts = flagOn('CUSTOMER_ACCOUNTS_ENABLED') && postgresPermissionsEnabled()
  const result = await bootstrapQuery(
    'SELECT * FROM photo_security.gateway_session_authority($1,$2::uuid,$3,$4)',
    [subject, sid, startedAt ?? null, customerAccounts],
  )
  return result.rows[0]
}
/** Only signed, token-bound role cache envelopes; no direct table privileges. */
export async function pgReadRoleCache(key: string): Promise<string | undefined> {
  return (
    (await bootstrapQuery('SELECT photo_security.read_role_cache($1) AS envelope', [key])).rows[0]
      ?.envelope ?? undefined
  )
}
export async function pgWriteRoleCache(
  key: string,
  envelope: string,
  expires: number,
): Promise<void> {
  await bootstrapQuery('SELECT photo_security.write_role_cache($1,$2,$3)', [key, envelope, expires])
}
export async function pgAuthEpoch(username?: string): Promise<string> {
  const ctx = databaseContext.getStore()
  if (username !== undefined && ctx?.kind === 'request') {
    // Fetch both bootstrap facts in one round trip. Reuse only within this
    // request, for this exact caller; fresh authorization replaces the fact.
    ctx.nativeMainAdmin = undefined
    const row = (
      await bootstrapQuery(
        'SELECT photo_security.authorization_epoch() AS epoch, photo_security.main_admin($1) AS allowed',
        [username],
      )
    ).rows[0]
    ctx.nativeMainAdmin = { username, allowed: row.allowed === true }
    return row.epoch
  }
  return (await bootstrapQuery('SELECT photo_security.authorization_epoch() AS epoch')).rows[0]
    .epoch
}
export async function pgAuthMainAdmin(username: string): Promise<boolean> {
  const ctx = databaseContext.getStore()
  if (ctx?.kind === 'request' && ctx.nativeMainAdmin?.username === username)
    return ctx.nativeMainAdmin.allowed
  return (
    (await bootstrapQuery('SELECT photo_security.main_admin($1) AS allowed', [username])).rows[0]
      ?.allowed === true
  )
}
export async function pgAuthRevoke(sid: string): Promise<void> {
  await bootstrapQuery('SELECT photo_security.revoke_session($1::uuid)', [sid])
}
/** Session lock coordinates background jobs across instances without an always-on worker. */
export async function withAdvisoryLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const lockContext = databaseContext.getStore()
  const client = await acquireDatabaseClient<pg.PoolClient>(
    getSessionPool(lockContext?.kind === 'service'),
    databaseSignal(),
  )
  let locked = false
  const lifetime = databaseClientLifetime(client, databaseSignal())
  let broken = false
  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [name],
    )
    locked = result.rows[0].locked
    if (!locked) return null
    return await fn()
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [name])
      } catch {
        broken = true
      }
    }
    lifetime.release(broken)
  }
}

/** Durable storage intents must survive rollback of the metadata transaction. */
export async function pgIndependent<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return independentScope.run(true, () =>
    transaction.run(undefined as unknown as pg.PoolClient, () => pgQuery<T>(sql, params)),
  )
}

/** A verified server caller, local to one short read transaction. Never spans network/media work. */
export async function pgReadIdentity<T>(
  identity: { username: string; mainAdmin: boolean },
  fn: () => Promise<T>,
  options?: { disableJit?: boolean; singleQuery?: boolean },
): Promise<T> {
  if (transaction.getStore()) throw new Error('Read identity cannot replace an active transaction')
  if (singleReadScope.getStore())
    throw new Error('Read identity cannot replace an active scoped read')
  if (options?.singleQuery)
    return singleReadScope.run({ identity, disableJit: !!options.disableJit, used: false }, fn)
  const client = await checkout()
  const lifetime = databaseClientLifetime(client, databaseSignal())
  let broken = false
  try {
    if (flagOn('PG_BATCH_TRANSACTION_START_ENABLED')) {
      await uploadRequestStep('db-transaction-start', () =>
        client.query(readTransactionStart(identity, options?.disableJit)),
      )
    } else {
      // Static statements share one round trip; identity remains parameterized below.
      await uploadRequestStep('db-transaction-start', async () => {
        await client.query(
          'BEGIN READ ONLY; SET LOCAL ROLE personal_photos_reader' +
            (options?.disableJit ? '; SET LOCAL jit=off' : ''),
        )
        await client.query(
          "SELECT set_config('photos.username',$1,true),set_config('photos.main_admin',$2,true)",
          [identity.username, identity.mainAdmin ? 'true' : 'false'],
        )
      })
    }
    const result = await transaction.run(client, fn)
    await uploadRequestStep('db-transaction-commit', () => client.query('COMMIT'))
    return result
  } catch (error) {
    try {
      await uploadRequestStep('db-transaction-rollback', () => client.query('ROLLBACK'))
    } catch {
      broken = true
    }
    throw error
  } finally {
    lifetime.release(broken)
  }
}

/** Narrow pre-account bootstrap: caller must verify the route-bound gateway assertion first. */
export async function pgRegisterCustomer(
  subject: string,
  claims: { issuer: string; email: string; displayName: string; verified: boolean },
  jti: string,
  exp: number,
) {
  return (
    await bootstrapQuery(
      'SELECT photo_security.register_customer($1,$2,$3,$4,$5,$6::uuid,$7) AS username',
      [subject, claims.issuer, claims.email, claims.displayName, claims.verified, jti, exp],
    )
  ).rows[0]
}
export async function pgCredentialChange(subject: string, cutoff: number) {
  await bootstrapQuery('SELECT photo_security.record_credential_change($1,$2)', [subject, cutoff])
}
