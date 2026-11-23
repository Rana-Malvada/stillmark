import { sfLog } from './snowflake/logging'
import {
  type Binds,
  connectAndQuery,
  connectAndQueryLongRunning,
  queryWithPool,
  queryWithPoolLongRunning,
} from './snowflake/query-execution'
import {
  baseConfig,
  readTomlDefaultConnection,
  type TomlConnection,
  tomlConnectionConfig,
} from './snowflake/connection-config'

export { readTomlDefaultConnection, resetTomlConfigCache } from './snowflake/connection-config'
export { getSecret, SecretType, type PasswordSecret } from './snowflake/secrets'
import { databaseSignal } from './database/database-context'
import {
  snowflakeCallerRetention,
  snowflakePoolConfig,
  snowflakeStoragePoolConfig,
} from './snowflake/snowflake-capacity'
import { retireConnectionPool } from './pool-retirement'
import { CallerPoolCache } from './caller-pool-cache'
import { useConnectionWithDeadline } from './connection-deadline'
import {
  uploadRequestStep,
  uploadTraceCount,
  uploadTraceDuration,
  uploadTraceGauge,
} from './upload/upload-request-trace'
/**
 * Snowflake query helper. Call from any server component or route handler:
 *   const rows = await querySnowflake("SELECT ...")
 *   const rows = await querySnowflake("SELECT ...", { callersRights: true })
 *   const rows = await querySnowflake("SELECT ...", { warehouse: "MY_WH" })
 *
 * Variable binding (recommended for any user-supplied values — prevents SQL injection):
 *   const rows = await querySnowflake(
 *     "SELECT * FROM t WHERE id = ? AND status = ?",
 *     { binds: [id, status] },
 *   )
 *   Use `?` placeholders in the SQL and pass values via the `binds` option. Binds are
 *   supported on both helpers and on queryWithToken(...). See the Snowflake SDK docs for
 *   supported bind value types.
 *
 * Which helper to use:
 *   - querySnowflake — default for simple, fast queries (small lookups, tight filters,
 *     typically well under ~10 seconds end-to-end).
 *   - querySnowflakeLongRunning — use when the work may exceed ~10 seconds or is
 *     warehouse-heavy (large scans, big aggregations, COPY/EXPORT, long-running
 *     procedures, resuming warehouse, etc.). Submits async, polls by query id, then
 *     fetches rows:
 *       const rows = await querySnowflakeLongRunning("CALL MY_LONG_JOB(...)")
 *   Same auth options (callersRights, pools) apply to both.
 *
 * Logging: by default prints concise lines (auth path, timing, truncated SQL, queryId on
 * success). Set SNOWFLAKE_SDK_QUIET=1 to disable. SDK internal logs stay at ERROR unless
 * you change snowflake.configure below.
 *
 * Auth is auto-detected (in priority order):
 *   1. SPCS token file (/snowflake/session/token) — read fresh on every call
 *   2. SNOWFLAKE_USER + SNOWFLAKE_PASSWORD env vars — password auth (local dev)
 *   3. ~/.snowflake/config.toml default connection — zero-config local dev
 *
 * Connection pooling:
 *   Owner's rights: single pool per process, recreated when the service token rotates.
 *   Caller's rights: one pool per user+role (keyed by combined token), all drained
 *     when the service token rotates.
 *   Local dev pools (password / toml) are shared and never rotated.
 *
 * SPCS caller's rights helpers:
 *   queryWithToken(query, token) — runs a query with an explicit OAuth token.
 *   getServiceToken() — reads the SPCS service token from /snowflake/session/token.
 *   buildCallerRightsToken(callerUserToken) — combines service + caller tokens.
 *
 * Secrets:
 *   getSecret(name, type) — reads a Snowflake SECRET value at runtime. Use this instead of
 *     reading SNOWFLAKE_SECRET_* env vars or querying the SECRET object directly (see the
 *     getSecret docstring in snowflake/secrets.ts). The secret must be declared under `secrets:` in app.yml to
 *     be available in SPCS.
 *
 * Cleanup:
 *   closePool() — drains and destroys all active pools on shutdown.
 */

import { headers } from 'next/headers'
import fs from 'fs'
import snowflake from 'snowflake-sdk'

snowflake.configure({
  logLevel: 'ERROR',
  ...(process.env.SNOWFLAKE_SDK_DISABLE_OCSP === 'true' && {
    disableOCSPChecks: true,
    ocspFailOpen: true,
  }),
})

const SPCS_TOKEN_PATH = '/snowflake/session/token'

// --- Connection pool configuration ---

const callerRetention = snowflakeCallerRetention()

// Owner's rights: single pool, recreated when the service token rotates.
let ownersPool: ReturnType<typeof snowflake.createPool> | null = null
let ownersPoolToken = ''

// Caller's rights: one pool per combined token (user+role), keyed by combined token.
// All pools are drained when the service token rotates.
const callersPool = new CallerPoolCache<ReturnType<typeof snowflake.createPool>>(
  retireInBackground,
  callerRetention.idleMs,
  callerRetention.maxIdle,
)
let callersServiceToken = ''

// Local dev pools.
let passwordPool: ReturnType<typeof snowflake.createPool> | null = null
let tomlPool: ReturnType<typeof snowflake.createPool> | null = null

// --- Pool helpers ---

function retireInBackground(pool: ReturnType<typeof snowflake.createPool>) {
  void retireConnectionPool(pool).catch(() => {
    console.warn('[snowflake] Retired connection pool cleanup failed')
  })
}

function getOwnersPool(serviceToken: string): ReturnType<typeof snowflake.createPool> {
  if (ownersPool && ownersPoolToken !== serviceToken) {
    sfLog("pool: draining owner's-rights pool (SPCS service token rotated)")
    retireInBackground(ownersPool)
    ownersPool = null
  }
  if (!ownersPool) {
    sfLog("pool: creating owner's-rights OAuth pool (SPCS)")
    ownersPool = snowflake.createPool(
      { ...baseConfig(), authenticator: 'OAUTH', token: serviceToken },
      snowflakePoolConfig(),
    )
    ownersPoolToken = serviceToken
  }
  return ownersPool
}

function getCallersPool(
  combinedToken: string,
  serviceToken: string,
  profile?: 'role-check',
): ReturnType<typeof snowflake.createPool> {
  // Service token rotated — all combined tokens are stale, drain everything.
  if (callersServiceToken !== serviceToken) {
    if (callersPool.size > 0) {
      sfLog(
        `pool: draining ${callersPool.size} caller's-rights pool(s) (SPCS service token rotated)`,
      )
    }
    for (const pool of callersPool.values()) retireInBackground(pool)
    callersPool.clear()
    callersServiceToken = serviceToken
  }
  const poolKey = `${profile ?? 'default'}\0${combinedToken}`
  uploadTraceCount(callersPool.has(poolKey) ? 'caller-pool-reused' : 'caller-pool-created')
  const pool = callersPool.getOrCreate(poolKey, () => {
    sfLog("pool: creating caller's-rights OAuth pool (SPCS)")
    return snowflake.createPool(
      {
        ...baseConfig(),
        authenticator: 'OAUTH',
        token: combinedToken,
        // This pool is used only for the small, read-only authorization query.
        // Never reuse its short network timeout for storage or batch statements.
        ...(profile === 'role-check' ? { timeout: 5000, sfRetryMaxLoginRetries: 0 } : {}),
      },
      // Also remove expired borrowers from the pool's own queue. A caller-side
      // timer alone leaves factory retries alive during a persistent outage.
      {
        ...snowflakePoolConfig(),
        ...(profile === 'role-check' ? { acquireTimeoutMillis: 5000 } : {}),
      },
    )
  })
  uploadTraceGauge('caller-pools', callersPool.size)
  uploadTraceGauge('caller-pool-borrowed', pool.borrowed)
  uploadTraceGauge('caller-pool-available', pool.available)
  uploadTraceGauge('caller-pool-pending', pool.pending)
  uploadTraceGauge('caller-pool-size', pool.size)
  return pool
}

function getPasswordPool(): ReturnType<typeof snowflake.createPool> {
  if (!passwordPool) {
    sfLog('pool: creating password-auth pool (SNOWFLAKE_USER)')
    passwordPool = snowflake.createPool(
      {
        ...baseConfig(),
        username: process.env.SNOWFLAKE_USER,
        password: process.env.SNOWFLAKE_PASSWORD,
      },
      snowflakePoolConfig(),
    )
  }
  return passwordPool
}

function getTomlPool(conn: TomlConnection): ReturnType<typeof snowflake.createPool> {
  if (!tomlPool) {
    sfLog('pool: creating TOML default-connection pool (~/.snowflake)')
    tomlPool = snowflake.createPool(
      { ...tomlConnectionConfig(conn), ...baseConfig() },
      snowflakePoolConfig(),
    )
  }
  return tomlPool
}

interface QueryOptions {
  /** Dedicated caller pool with a short per-HTTP-attempt timeout for role checks. */
  connectionProfile?: 'role-check'
  /** Optional caller-auth acquisition budget; does not time out or retry SQL. */
  connectionWaitMs?: number
  callersRights?: boolean
  /**
   * Run this query on a specific warehouse. Sets the QUERY_WAREHOUSE_NAME
   * statement parameter for the execution. When omitted, the connection's
   * default warehouse is used.
   */
  warehouse?: string
  /**
   * Bind values for `?` placeholders in the SQL. Use this for any user-supplied
   * values to avoid SQL injection, e.g.
   *   querySnowflake("SELECT * FROM t WHERE id = ?", { binds: [id] })
   */
  binds?: Binds
}

/** Extra options for `querySnowflakeLongRunning` / `queryWithTokenLongRunning`. */
export interface LongRunningQueryOptions extends Omit<QueryOptions, 'connectionProfile'> {
  /**
   * How often to call GS while the query is running (default 5000).
   * Kept conservative to limit log volume and API chatter.
   */
  pollIntervalMs?: number
  /**
   * While running, emit at most one `[snowflake] long-running poll …` line per this many ms (default 60000).
   */
  statusLogIntervalMs?: number
  /** Fail if the query is still not finished after this many ms (optional). */
  maxWaitMs?: number
  signal?: AbortSignal
}

function resolveLongRunningOpts(o: LongRunningQueryOptions): {
  pollIntervalMs: number
  statusLogIntervalMs: number
  maxWaitMs?: number
  signal?: AbortSignal
} {
  return {
    pollIntervalMs: o.pollIntervalMs ?? 5000,
    statusLogIntervalMs: o.statusLogIntervalMs ?? 60_000,
    maxWaitMs: o.maxWaitMs,
    signal: o.signal,
  }
}

export async function querySnowflake(
  query: string,
  options: QueryOptions = {},
): Promise<Record<string, any>[]> {
  const { callersRights = false, warehouse, binds } = options
  if (options.connectionProfile && !callersRights)
    throw new Error('Role-check connection profile requires caller rights')
  const serviceToken = getServiceToken()

  if (serviceToken) {
    if (callersRights) {
      const callerToken = (await headers()).get('sf-context-current-user-token') ?? ''
      if (!callerToken) {
        throw new Error(
          "No sf-context-current-user-token header. Ensure the app is running in SPCS with caller's rights enabled.",
        )
      }
      const combinedToken = serviceToken + '.' + callerToken
      return queryWithPool(
        getCallersPool(combinedToken, serviceToken, options.connectionProfile),
        query,
        'spcs-caller',
        warehouse,
        binds,
        options.connectionWaitMs ?? (options.connectionProfile === 'role-check' ? 5000 : undefined),
        options.connectionProfile === 'role-check',
      )
    }
    // Retry once on terminated connection (service token rotated mid-flight).
    try {
      return await queryWithPool(getOwnersPool(serviceToken), query, 'spcs-owner', warehouse, binds)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      databaseSignal()?.throwIfAborted()
      if (msg.includes('terminated connection')) {
        sfLog('query retry: terminated connection — clearing owner pool and retrying once')
        if (ownersPool) retireInBackground(ownersPool)
        ownersPool = null
        return queryWithPool(getOwnersPool(serviceToken), query, 'spcs-owner', warehouse, binds)
      }
      throw err
    }
  }

  // Local dev: no SPCS token, so caller's rights is not possible.
  if (callersRights) {
    console.warn(
      '[snowflake] useCallersRights=true has no effect outside SPCS — using local dev credentials',
    )
  }

  // Explicit env vars: password auth via pooled connections
  if (process.env.SNOWFLAKE_USER && process.env.SNOWFLAKE_PASSWORD) {
    return queryWithPool(getPasswordPool(), query, 'password', warehouse, binds)
  }

  // ~/.snowflake/connections.toml or config.toml: use the default connection (local dev)
  const tomlConn = readTomlDefaultConnection()
  if (tomlConn) {
    return queryWithPool(getTomlPool(tomlConn), query, 'toml', warehouse, binds)
  }

  throw new Error(
    'No Snowflake credentials found. Provide one of:\n' +
      '  1. SPCS token file at /snowflake/session/token\n' +
      '  2. SNOWFLAKE_USER + SNOWFLAKE_PASSWORD env vars\n' +
      '  3. ~/.snowflake/config.toml with a default connection',
  )
}

// Intentionally nonexistent: omitting warehouse can inherit the user's default.
// Never provision this name. Verify the resulting session before any storage work.
const STORAGE_NO_WAREHOUSE = 'PERSONAL_PHOTOS_STORAGE_NO_WAREHOUSE'
let storagePool: ReturnType<typeof snowflake.createPool> | null = null
let storageToken = ''
const validatedStorageConnections = new WeakSet<snowflake.Connection>()

/** Storage-only owner connection. No fallback to the processing pool on failure. */
export async function querySnowflakeStorage(query: string): Promise<Record<string, any>[]> {
  const signal = databaseSignal()
  signal?.throwIfAborted()
  const literal = "'(?:[^']|'')*'"
  const stage = '@[A-Za-z_][A-Za-z0-9_.$]*'
  const signingColumn = `GET_PRESIGNED_URL\\(${stage}, ${literal}, [0-9]+\\) AS URL[0-9]+`
  const allowed = [
    new RegExp(`^SELECT ${signingColumn}(?:, ${signingColumn}){0,31}$`, 'i'),
    new RegExp(`^SELECT GET_PRESIGNED_URL\\(${stage}, ${literal}, [0-9]+\\) AS URL$`, 'i'),
    new RegExp(`^PUT ${literal} ${literal} AUTO_COMPRESS=FALSE OVERWRITE=TRUE$`, 'i'),
    new RegExp(`^REMOVE ${stage} PATTERN=${literal}$`, 'i'),
    new RegExp(`^REMOVE '${stage}/[^'\\\\\\r\\n]+' PATTERN=${literal}$`, 'i'),
  ]
  if (!allowed.some((pattern) => pattern.test(query))) {
    throw new Error('Storage connection only accepts stage uploads, cleanup, and signed URLs')
  }
  const token = getServiceToken()
  if (storagePool && storageToken !== token) {
    const old = storagePool
    storagePool = null
    retireInBackground(old)
  }
  if (!storagePool) {
    let config: snowflake.ConnectionOptions
    if (token) {
      config = { ...baseConfig(), authenticator: 'OAUTH', token }
    } else if (process.env.SNOWFLAKE_USER && process.env.SNOWFLAKE_PASSWORD) {
      config = {
        ...baseConfig(),
        username: process.env.SNOWFLAKE_USER,
        password: process.env.SNOWFLAKE_PASSWORD,
      }
    } else {
      const toml = readTomlDefaultConnection()
      if (!toml) throw new Error('No Snowflake storage credentials found')
      config = { ...tomlConnectionConfig(toml), ...baseConfig() }
    }
    storagePool = snowflake.createPool(
      { ...config, warehouse: STORAGE_NO_WAREHOUSE },
      snowflakeStoragePoolConfig(),
    )
    storageToken = token
  }
  uploadTraceGauge('storage-pool-pending', storagePool.pending)
  uploadTraceGauge('storage-pool-borrowed', storagePool.borrowed)
  const checkoutStarted = performance.now()
  const pool = storagePool
  return useConnectionWithDeadline(
    pool,
    async (conn) => {
      uploadTraceDuration('storage-checkout', performance.now() - checkoutStarted)
      // This private pool accepts only the storage allowlist above: no USE, ALTER,
      // session changes, or warehouse statement parameters. New pool connections
      // must pass validation; any failed operation invalidates it before reuse.
      const session = { use: async <T>(fn: (c: typeof conn) => Promise<T>) => fn(conn) }
      try {
        if (!validatedStorageConnections.has(conn)) {
          const rows = await uploadRequestStep('storage-warehouse-check', () =>
            queryWithPool(session, 'SELECT CURRENT_WAREHOUSE() AS WAREHOUSE', 'storage-check'),
          )
          if (rows.length !== 1 || rows[0].WAREHOUSE !== null)
            throw new Error(
              'Storage connection unexpectedly selected a warehouse; refusing operation',
            )
          validatedStorageConnections.add(conn)
        }
        return await uploadRequestStep('storage-execute', () =>
          queryWithPool(session, query, 'storage'),
        )
      } catch (error) {
        validatedStorageConnections.delete(conn)
        throw error
      }
    },
    snowflakeStoragePoolConfig().acquireTimeoutMillis,
    signal,
  )
}

/**
 * Same auth and pooling as {@link querySnowflake}, but submits with `asyncExec`, then polls
 * by `queryId` until the statement finishes (intended for queries that often exceed ~1 minute).
 */
export async function querySnowflakeLongRunning(
  query: string,
  options: LongRunningQueryOptions = {},
): Promise<Record<string, any>[]> {
  const { callersRights = false, warehouse, binds, ...longRest } = options
  const longOpts = resolveLongRunningOpts({ callersRights, ...longRest })
  const serviceToken = getServiceToken()

  if (serviceToken) {
    if (callersRights) {
      const callerToken = (await headers()).get('sf-context-current-user-token') ?? ''
      if (!callerToken) {
        throw new Error(
          "No sf-context-current-user-token header. Ensure the app is running in SPCS with caller's rights enabled.",
        )
      }
      const combinedToken = serviceToken + '.' + callerToken
      return queryWithPoolLongRunning(
        getCallersPool(combinedToken, serviceToken),
        query,
        'spcs-caller',
        longOpts,
        warehouse,
        binds,
      )
    }
    return queryWithPoolLongRunning(
      getOwnersPool(serviceToken),
      query,
      'spcs-owner',
      longOpts,
      warehouse,
      binds,
    )
  }

  if (callersRights) {
    console.warn(
      '[snowflake] useCallersRights=true has no effect outside SPCS — using local dev credentials',
    )
  }

  if (process.env.SNOWFLAKE_USER && process.env.SNOWFLAKE_PASSWORD) {
    return queryWithPoolLongRunning(
      getPasswordPool(),
      query,
      'password',
      longOpts,
      warehouse,
      binds,
    )
  }

  const tomlConn = readTomlDefaultConnection()
  if (tomlConn) {
    return queryWithPoolLongRunning(
      getTomlPool(tomlConn),
      query,
      'toml',
      longOpts,
      warehouse,
      binds,
    )
  }

  throw new Error(
    'No Snowflake credentials found. Provide one of:\n' +
      '  1. SPCS token file at /snowflake/session/token\n' +
      '  2. SNOWFLAKE_USER + SNOWFLAKE_PASSWORD env vars\n' +
      '  3. ~/.snowflake/config.toml with a default connection',
  )
}

// --- SPCS caller's rights helpers ---

export function getServiceToken(): string {
  try {
    return fs.readFileSync(SPCS_TOKEN_PATH, 'utf8').trim()
  } catch {
    return ''
  }
}

export function buildCallerRightsToken(callerUserToken: string): string {
  const serviceToken = getServiceToken()
  if (!serviceToken) {
    throw new Error('No SPCS service token available at ' + SPCS_TOKEN_PATH)
  }
  return serviceToken + '.' + callerUserToken
}

/**
 * Run a query using an explicit OAuth token (for service-rights or caller's-rights).
 * Creates a fresh connection each time since the token may differ per request.
 * Pass `warehouse` to run the query on a specific warehouse (QUERY_WAREHOUSE_NAME).
 * Pass `binds` for `?` placeholder values (recommended for user-supplied input).
 */
export async function queryWithToken(
  query: string,
  token: string,
  warehouse?: string,
  binds?: Binds,
): Promise<Record<string, any>[]> {
  return connectAndQuery(
    { ...baseConfig(), authenticator: 'OAUTH', token },
    query,
    'oauth-token',
    warehouse,
    binds,
  )
}

/**
 * One-shot OAuth connection: async submit + poll + fetch (see {@link querySnowflakeLongRunning}).
 */
export async function queryWithTokenLongRunning(
  query: string,
  token: string,
  options: Omit<LongRunningQueryOptions, 'callersRights'> = {},
): Promise<Record<string, any>[]> {
  const { warehouse, binds, ...longRest } = options
  const longOpts = resolveLongRunningOpts({ callersRights: false, ...longRest })
  return connectAndQueryLongRunning(
    { ...baseConfig(), authenticator: 'OAUTH', token },
    query,
    'oauth-token',
    longOpts,
    warehouse,
    binds,
  )
}

// --- Pool lifecycle ---

/**
 * Gracefully drain and destroy all active connection pools.
 * Call during server shutdown for clean resource cleanup.
 */
export async function closePool(): Promise<void> {
  const drainPromises: Promise<void>[] = []
  if (storagePool) {
    const p = storagePool
    storagePool = null
    storageToken = ''
    drainPromises.push(retireConnectionPool(p))
  }

  if (ownersPool) {
    const p = ownersPool
    ownersPool = null
    ownersPoolToken = ''
    drainPromises.push(retireConnectionPool(p))
  }

  for (const pool of callersPool.values()) {
    drainPromises.push(retireConnectionPool(pool))
  }
  callersPool.clear()

  if (passwordPool) {
    const p = passwordPool
    passwordPool = null
    drainPromises.push(retireConnectionPool(p))
  }

  if (tomlPool) {
    const p = tomlPool
    tomlPool = null
    drainPromises.push(retireConnectionPool(p))
  }

  await Promise.all(drainPromises)
}

/** Returns the Snowflake account base URL for REST API calls (Cortex Analyst, etc.). */
export function getSnowflakeBaseUrl(): string | null {
  if (process.env.SNOWFLAKE_ACCOUNT_URL) return process.env.SNOWFLAKE_ACCOUNT_URL
  if (process.env.SNOWFLAKE_HOST) return `https://${process.env.SNOWFLAKE_HOST}`
  const conn = readTomlDefaultConnection()
  if (!conn) return null
  if (conn.host) {
    const protocol = (conn.protocol as string | undefined) ?? 'https'
    const port = conn.port ? `:${conn.port}` : ''
    return `${protocol}://${conn.host}${port}`
  }
  if (conn.account) {
    // "MYORG-MY_ACCOUNT" → "myorg-my-account.snowflakecomputing.com"
    return `https://${(conn.account as string).toLowerCase().replace(/_/g, '-')}.snowflakecomputing.com`
  }
  return null
}

/**
 * Returns the Authorization header value for Snowflake REST API calls.
 * Both SPCS service tokens and external OAuth tokens use "Bearer ..." format.
 * Callers must also send `X-Snowflake-Authorization-Token-Type: OAUTH`.
 * (The "Snowflake Token=..." form is rejected with 401/390104 by the Cortex
 * inference endpoint when using an SPCS service token.)
 */
export function getRestApiAuthHeader(): string {
  const spcsToken = getServiceToken()
  if (spcsToken) return `Bearer ${spcsToken}`
  const conn = readTomlDefaultConnection()
  if (conn) {
    const auth = (typeof conn.authenticator === 'string' ? conn.authenticator : '').toUpperCase()
    if (auth === 'OAUTH' && conn.token_file_path) {
      try {
        return `Bearer ${fs.readFileSync(conn.token_file_path as string, 'utf8').trim()}`
      } catch {
        /* token file missing or unreadable */
      }
    }
  }
  return `Bearer ` // will 401 — no valid local auth available
}
