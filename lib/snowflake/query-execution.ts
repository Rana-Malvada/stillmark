import snowflake from 'snowflake-sdk'
import { setTimeout as delay } from 'node:timers/promises'
import { runWithSignal } from 'snowflake-sdk/dist/lib/http/stillmark_deadline'
import { databaseSignal } from '../database/database-context'
import { acquireRoleConnection } from '../role-connection'
import { useConnectionWithDeadline } from '../connection-deadline'
import { discardRoleConnection, withSnowflakeQueryDeadline } from './snowflake-query-deadline'
import { uploadRequestStep } from '../upload/upload-request-trace'
import { costQueryTag } from '../costs/cost-context'
import { previewSql, sfLog } from './logging'

/** Preserve diagnostic causes except when an SDK error may echo a password statement. */
function queryFailure(query: string, prefix: string, error: unknown): Error {
  const privateStatement = /\bPASSWORD\s*=/i.test(query)
  const detail = privateStatement
    ? 'Password operation failed'
    : error instanceof Error
      ? error.message
      : String(error)
  return new Error(`${prefix}: ${detail}`, { cause: privateStatement ? undefined : error })
}

/**
 * Build the `parameters` fragment for `conn.execute` when a per-query warehouse
 * override is requested. Sets the QUERY_WAREHOUSE_NAME statement parameter so the
 * query runs on the given warehouse without a separate `USE WAREHOUSE` round-trip.
 */
function warehouseParams(warehouse?: string): { parameters?: Record<string, unknown> } {
  return {
    parameters: {
      QUERY_TAG: costQueryTag(),
      ...(warehouse ? { QUERY_WAREHOUSE_NAME: warehouse } : {}),
    },
  }
}

/** SDK bind values for `?` placeholders. Kept as its own type since @types may lag. */
export type Binds = snowflake.Binds

/** Build the `binds` fragment for `conn.execute` when bind values are provided. */
function bindParams(binds?: Binds): { binds?: Binds } {
  return binds && binds.length > 0 ? { binds } : {}
}

/** The SDK supports these; @types/snowflake-sdk may lag — keep cast at boundary. */
type PollingConnection = snowflake.Connection & {
  getQueryStatus: (queryId: string) => Promise<string>
  getResultsFromQueryId: (opts: {
    queryId: string
  }) => Promise<{ streamRows: () => NodeJS.ReadableStream }>
  isStillRunning: (status: string) => boolean
  isAnError: (status: string) => boolean
  getQueryStatusThrowIfError: (queryId: string) => Promise<string>
}

type ExecuteOptions = Parameters<snowflake.Connection['execute']>[0] & { asyncExec?: boolean }

function streamRowsToArray(
  statement: {
    streamRows: () => NodeJS.ReadableStream
  },
  signal?: AbortSignal,
): Promise<Record<string, any>[]> {
  return new Promise((resolve, reject) => {
    const rows: Record<string, any>[] = []
    const stream = statement.streamRows()
    const abort = () => {
      ;(stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
      cleanup()
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
    const cleanup = () => signal?.removeEventListener('abort', abort)
    stream
      .on('error', (err: Error) => {
        cleanup()
        reject(err)
      })
      .on('data', (row: Record<string, any>) => rows.push(row))
      .on('end', () => {
        cleanup()
        resolve(rows)
      })
    if (signal?.aborted) abort()
  })
}

/**
 * Submit `asyncExec`, poll `getQueryStatus` until the warehouse finishes, then fetch rows.
 * Keeps status logs sparse (default: at most once per minute while running).
 */
async function runLongRunningOnConnection(
  conn: PollingConnection,
  query: string,
  options: {
    pollIntervalMs: number
    statusLogIntervalMs: number
    maxWaitMs?: number
    signal?: AbortSignal
  },
  warehouse?: string,
  binds?: Binds,
): Promise<Record<string, any>[]> {
  let submitted: snowflake.RowStatement | undefined
  options.signal?.throwIfAborted()
  let cancellation: Promise<void> | undefined
  const cancel = () =>
    (cancellation ??= new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000)
      submitted?.cancel(() => {
        clearTimeout(timer)
        resolve()
      })
    }))
  const aborted = () => {
    void runWithSignal(new AbortController().signal, cancel)
  }
  const work = async () => {
    const queryId = await new Promise<string>((resolve, reject) => {
      submitted = conn.execute({
        sqlText: query,
        asyncExec: true,
        parameters: {
          ...warehouseParams(warehouse).parameters,
          ...(options.maxWaitMs
            ? { STATEMENT_TIMEOUT_IN_SECONDS: Math.max(1, Math.ceil(options.maxWaitMs / 1000)) }
            : {}),
        },
        ...bindParams(binds),
        complete: (err, stmt) => {
          if (err) reject(queryFailure(query, 'Async submit failed', err))
          else resolve(stmt!.getQueryId())
        },
      } as ExecuteOptions)
    })

    if (options.signal?.aborted) {
      await cancel()
      options.signal.throwIfAborted()
    }
    const t0 = Date.now()
    sfLog(`long-running submitted queryId=${queryId} sql=${JSON.stringify(previewSql(query))}`)

    let lastStatusLog = t0
    while (true) {
      if (options.signal?.aborted) {
        await cancel()
        options.signal.throwIfAborted()
      }

      const status = await conn.getQueryStatus(queryId)
      options.signal?.throwIfAborted()
      if (conn.isAnError(status)) {
        try {
          await conn.getQueryStatusThrowIfError(queryId)
        } catch (e) {
          throw queryFailure(query, `Query failed (queryId=${queryId})`, e)
        }
        throw new Error(`Query failed (queryId=${queryId}): ${status}`)
      }
      if (!conn.isStillRunning(status)) break

      const now = Date.now()
      if (now - lastStatusLog >= options.statusLogIntervalMs) {
        sfLog(`long-running poll queryId=${queryId} status=${status} elapsedMs=${now - t0}`)
        lastStatusLog = now
      }
      await delay(options.pollIntervalMs, undefined, { signal: options.signal })
    }

    const statement = await conn.getResultsFromQueryId({ queryId })
    options.signal?.throwIfAborted()
    const rows = await streamRowsToArray(statement, options.signal)
    sfLog(`long-running complete queryId=${queryId} rows=${rows.length} totalMs=${Date.now() - t0}`)
    options.signal?.throwIfAborted()
    return rows
  }
  const controller = new AbortController()
  const parent = options.signal
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
  options = { ...options, signal }
  let rejectStopped!: (error: unknown) => void
  const stopped = new Promise<never>((_, reject) => {
    rejectStopped = reject
  })
  const stop = () => {
    aborted()
    rejectStopped(signal.reason)
  }
  signal.addEventListener('abort', stop, { once: true })
  const timer =
    options.maxWaitMs === undefined
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              new Error(`Long-running query timed out after ${options.maxWaitMs}ms`),
            ),
          options.maxWaitMs,
        )
  try {
    signal.throwIfAborted()
    return await Promise.race([runWithSignal(signal, work), stopped])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
    if (signal.aborted) await runWithSignal(new AbortController().signal, cancel)
  }
}

export function queryWithPool(
  pool: Pick<ReturnType<typeof snowflake.createPool>, 'use'> &
    Partial<Pick<ReturnType<typeof snowflake.createPool>, 'acquire' | 'release' | 'destroy'>>,
  query: string,
  authTag: string,
  warehouse?: string,
  binds?: Binds,
  connectionWaitMs?: number,
  roleDeadline = false,
): Promise<Record<string, any>[]> {
  const signal = databaseSignal()
  signal?.throwIfAborted()
  const work = async (conn: snowflake.Connection) => {
    signal?.throwIfAborted()
    const t0 = Date.now()
    sfLog(`query start mode=${authTag} sql=${JSON.stringify(previewSql(query))}`)
    const execute = () =>
      uploadRequestStep(
        'snowflake-execute',
        () =>
          new Promise<Record<string, any>[]>((res, rej) => {
            conn.execute({
              sqlText: query,
              ...warehouseParams(warehouse),
              ...bindParams(binds),
              ...(roleDeadline
                ? {
                    parameters: {
                      ...warehouseParams(warehouse).parameters,
                      STATEMENT_TIMEOUT_IN_SECONDS: 10,
                      STATEMENT_QUEUED_TIMEOUT_IN_SECONDS: 10,
                    },
                  }
                : {}),
              complete: (err, stmt, rows) => {
                const ms = Date.now() - t0
                const qid =
                  stmt && typeof stmt.getQueryId === 'function'
                    ? ` queryId=${stmt.getQueryId()}`
                    : ''
                if (err) {
                  sfLog(
                    `query error mode=${authTag} afterMs=${ms}${qid}: ${/\bPASSWORD\s*=/i.test(query) ? 'Password operation failed' : err.message}`,
                  )
                  rej(queryFailure(query, 'Query failed', err))
                } else {
                  const out = (rows ?? []) as Record<string, any>[]
                  sfLog(`query ok mode=${authTag} rows=${out.length} afterMs=${ms}${qid}`)
                  res(out)
                }
              },
            })
          }),
      )
    return roleDeadline
      ? withSnowflakeQueryDeadline(10_000, execute, signal)
      : signal
        ? runWithSignal(signal, execute)
        : execute()
  }
  return uploadRequestStep('snowflake-query', () => {
    if (connectionWaitMs === undefined && (!signal || !pool.acquire)) return pool.use(work)
    if (!pool.acquire || !pool.release || !pool.destroy)
      throw new Error('Connection deadlines require a managed pool')
    return useConnectionWithDeadline(
      {
        acquire: roleDeadline
          ? () =>
              acquireRoleConnection({
                acquire: pool.acquire!.bind(pool),
                release: pool.release!.bind(pool),
              })
          : pool.acquire.bind(pool),
        release: pool.release.bind(pool),
        destroy: roleDeadline
          ? (connection) => discardRoleConnection(connection, pool.destroy!.bind(pool))
          : pool.destroy.bind(pool),
      },
      work,
      connectionWaitMs ?? 10000,
      signal,
    )
  })
}

export function queryWithPoolLongRunning(
  pool: ReturnType<typeof snowflake.createPool>,
  query: string,
  authTag: string,
  longOpts: {
    pollIntervalMs: number
    statusLogIntervalMs: number
    maxWaitMs?: number
    signal?: AbortSignal
  },
  warehouse?: string,
  binds?: Binds,
): Promise<Record<string, any>[]> {
  const started = Date.now()
  const work = async (conn: snowflake.Connection) => {
    const remaining =
      longOpts.maxWaitMs === undefined ? undefined : longOpts.maxWaitMs - (Date.now() - started)
    if (remaining !== undefined && remaining <= 0)
      throw new Error('Long-running query timed out during connection acquisition')
    sfLog(`long-running start mode=${authTag} sql=${JSON.stringify(previewSql(query))}`)
    return runLongRunningOnConnection(
      conn as unknown as PollingConnection,
      query,
      { ...longOpts, maxWaitMs: remaining },
      warehouse,
      binds,
    )
  }
  // Never return a timed-out connection to the pool while an SDK operation may
  // still be unwinding. Destruction closes its transport before pool removal.
  if (!pool.acquire || !pool.release || !pool.destroy) return pool.use(work)
  return useConnectionWithDeadline(
    {
      acquire: pool.acquire.bind(pool),
      release: pool.release.bind(pool),
      destroy: (connection) => discardRoleConnection(connection, pool.destroy.bind(pool)),
    },
    work,
    longOpts.maxWaitMs ?? 10000,
    longOpts.signal,
  )
}

// --- One-shot connection helper (used for per-request tokens) ---

export function connectAndQuery(
  config: snowflake.ConnectionOptions,
  query: string,
  authTag: string,
  warehouse?: string,
  binds?: Binds,
): Promise<Record<string, any>[]> {
  const conn = snowflake.createConnection(config)
  const t0 = Date.now()
  sfLog(`query start mode=${authTag} (one-shot) sql=${JSON.stringify(previewSql(query))}`)
  return new Promise((resolve, reject) => {
    conn.connect((err) => {
      if (err) {
        sfLog(`connect failed mode=${authTag}: ${err.message}`)
        return reject(new Error(`Snowflake connection failed: ${err.message}`, { cause: err }))
      }
      conn.execute({
        sqlText: query,
        ...warehouseParams(warehouse),
        ...bindParams(binds),
        complete: (err, stmt, rows) => {
          conn.destroy(() => {})
          const ms = Date.now() - t0
          const qid =
            stmt && typeof stmt.getQueryId === 'function' ? ` queryId=${stmt.getQueryId()}` : ''
          if (err) {
            sfLog(
              `query error mode=${authTag} afterMs=${ms}${qid}: ${/\bPASSWORD\s*=/i.test(query) ? 'Password operation failed' : err.message}`,
            )
            reject(queryFailure(query, 'Query failed', err))
          } else {
            const out = (rows ?? []) as Record<string, any>[]
            sfLog(`query ok mode=${authTag} rows=${out.length} afterMs=${ms}${qid}`)
            resolve(out)
          }
        },
      })
    })
  })
}

export function connectAndQueryLongRunning(
  config: snowflake.ConnectionOptions,
  query: string,
  authTag: string,
  longOpts: {
    pollIntervalMs: number
    statusLogIntervalMs: number
    maxWaitMs?: number
    signal?: AbortSignal
  },
  warehouse?: string,
  binds?: Binds,
): Promise<Record<string, any>[]> {
  const conn = snowflake.createConnection(config)
  const t0 = Date.now()
  sfLog(`long-running start mode=${authTag} (one-shot) sql=${JSON.stringify(previewSql(query))}`)
  return new Promise((resolve, reject) => {
    conn.connect((err) => {
      if (err) {
        sfLog(`connect failed mode=${authTag}: ${err.message}`)
        return reject(new Error(`Snowflake connection failed: ${err.message}`, { cause: err }))
      }
      runLongRunningOnConnection(
        conn as unknown as PollingConnection,
        query,
        longOpts,
        warehouse,
        binds,
      )
        .then((rows) => {
          conn.destroy(() => {})
          sfLog(`long-running one-shot done mode=${authTag} totalMs=${Date.now() - t0}`)
          resolve(rows)
        })
        .catch((e) => {
          conn.destroy(() => {})
          reject(e)
        })
    })
  })
}
