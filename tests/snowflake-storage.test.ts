import { afterEach, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({
  fail: false,
  token: 'token-1',
  warehouse: null as string | null,
  create: vi.fn(),
  execute: vi.fn(),
  drain: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
  acquire: vi.fn(async (connection: any) => connection),
  release: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
}))
vi.mock('fs', () => ({ default: { readFileSync: () => s.token } }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('snowflake-sdk', () => ({
  default: {
    configure: vi.fn(),
    createPool: (config: unknown, options: unknown) => {
      s.create(config, options)
      const conn = {
        execute: (o: any) => {
          s.execute(o)
          const error = s.fail ? new Error('connection failed') : null
          s.fail = false
          o.complete(
            error,
            {},
            o.sqlText.includes('CURRENT_WAREHOUSE')
              ? [{ WAREHOUSE: s.warehouse }]
              : [{ URL: 'https://example.com' }],
          )
        },
      }
      return {
        drain: s.drain,
        clear: s.clear,
        use: async (fn: any) => fn(conn),
        acquire: () => s.acquire(conn),
        release: s.release,
        destroy: s.destroy,
      }
    },
  },
}))
import { closePool, querySnowflake, querySnowflakeStorage } from '@/lib/snowflake'
import { databaseContext } from '@/lib/database/database-context'

const signed = "SELECT GET_PRESIGNED_URL(@DB.RAW.FILES, 'originals/photo.jpg', 300) AS URL"
afterEach(async () => {
  await closePool()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  s.fail = false
  s.warehouse = null
  s.token = 'token-1'
  s.acquire.mockReset().mockImplementation(async (connection: any) => connection)
  vi.useRealTimers()
})
it('isolates storage from the processing warehouse and preserves normal processing', async () => {
  vi.stubEnv('SNOWFLAKE_WAREHOUSE', 'COMPUTE_WH')
  await querySnowflake('SELECT 1')
  await querySnowflakeStorage(signed)
  expect(s.create.mock.calls.map(([c]) => c.warehouse)).toEqual([
    'COMPUTE_WH',
    'PERSONAL_PHOTOS_STORAGE_NO_WAREHOUSE',
  ])
  expect(s.execute.mock.calls.map(([o]) => o.sqlText)).toEqual([
    'SELECT 1',
    'SELECT CURRENT_WAREHOUSE() AS WAREHOUSE',
    signed,
  ])
  expect(s.execute.mock.calls[2][0].parameters).not.toHaveProperty('QUERY_WAREHOUSE_NAME')
})
it('refuses storage work when a warehouse was inherited or selected', async () => {
  s.warehouse = 'COMPUTE_WH'
  await expect(querySnowflakeStorage(signed)).rejects.toThrow('refusing operation')
  expect(s.execute).toHaveBeenCalledTimes(1)
})
it('accepts uploads and cleanup but rejects SQL processing and multi statements', async () => {
  await querySnowflakeStorage(
    "PUT 'file:///tmp/photo.jpg' '@DB.RAW.FILES/originals/' AUTO_COMPRESS=FALSE OVERWRITE=TRUE",
  )
  await querySnowflakeStorage("REMOVE @DB.RAW.FILES PATTERN='originals/photo.jpg'")
  for (const sql of [
    'USE WAREHOUSE COMPUTE_WH',
    'SELECT * FROM photos',
    signed + '; SELECT 1',
    "SELECT GET_PRESIGNED_URL(@DB.RAW.FILES, 'x', 300) AS URL FROM photos",
  ]) {
    await expect(querySnowflakeStorage(sql)).rejects.toThrow('only accepts')
  }
  expect(s.execute).toHaveBeenCalledTimes(3)
})
it('rotates storage credentials and drains its pool on shutdown', async () => {
  await querySnowflakeStorage(signed)
  s.token = 'token-2'
  await querySnowflakeStorage(signed)
  expect(s.create.mock.calls.map(([c]) => c.token)).toEqual(['token-1', 'token-2'])
  expect(s.drain).toHaveBeenCalledTimes(1)
  expect(s.clear).toHaveBeenCalledTimes(1)
  await closePool()
  expect(s.drain).toHaveBeenCalledTimes(2)
  expect(s.clear).toHaveBeenCalledTimes(2)
})

it('does not block new storage work behind an old credential pool draining', async () => {
  vi.useFakeTimers()
  await querySnowflakeStorage(signed)
  let drained!: () => void
  s.drain.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        drained = resolve
      }),
  )
  s.token = 'token-2'
  let completed = false
  const next = querySnowflakeStorage(signed).then(() => {
    completed = true
  })
  try {
    await vi.advanceTimersByTimeAsync(1)
    expect(completed).toBe(true)
    expect(s.create.mock.calls.map(([config]) => config.token)).toEqual(['token-1', 'token-2'])
  } finally {
    drained()
    await next
  }
})

it('accepts prefix-scoped removal without selecting a warehouse, and rejects appended statements', async () => {
  const sql = "REMOVE '@DB.RAW.FILES/upload-chunks/' PATTERN='(^|.*/)(upload-chunks/a/1[.]bin)$'"
  await querySnowflakeStorage(sql)
  expect(s.create.mock.calls[0][0].warehouse).toBe('PERSONAL_PHOTOS_STORAGE_NO_WAREHOUSE')
  expect(s.execute.mock.calls[1][0].parameters).not.toHaveProperty('QUERY_WAREHOUSE_NAME')
  await expect(querySnowflakeStorage(sql + '; USE WAREHOUSE COMPUTE_WH')).rejects.toThrow(
    'only accepts',
  )
})

it('uses the storage budget independently of caller and processing pools', async () => {
  vi.stubEnv('SF_POOL_MAX', '3')
  vi.stubEnv('SF_STORAGE_POOL_MAX', '12')
  await querySnowflake('SELECT 1')
  await querySnowflakeStorage(signed)
  expect(s.create.mock.calls.map(([, options]) => options)).toEqual([
    { min: 0, max: 3 },
    { min: 0, max: 12, acquireTimeoutMillis: 10000, maxWaitingClients: 128 },
  ])
})

it.each(['timeout', 'abort'])(
  'bounds outer storage checkout on %s and returns a late connection without SQL',
  async (reason) => {
    vi.useFakeTimers()
    vi.stubEnv('SF_STORAGE_CHECKOUT_TIMEOUT_MS', '50')
    let provide!: () => void
    let connection: unknown
    s.acquire.mockImplementationOnce((conn) => {
      connection = conn
      return new Promise((resolve) => {
        provide = () => resolve(conn)
      })
    })
    const controller = new AbortController()
    const pending = databaseContext.run({ kind: 'request', signal: controller.signal }, () =>
      querySnowflakeStorage(signed),
    )
    const rejected = expect(pending).rejects.toThrow(
      reason === 'timeout' ? 'wait timed out' : 'caller left',
    )
    if (reason === 'abort') controller.abort(new Error('caller left'))
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expect(s.execute).not.toHaveBeenCalled()
    provide()
    await vi.advanceTimersByTimeAsync(1)
    expect(s.release).toHaveBeenCalledWith(connection)
    expect(s.execute).not.toHaveBeenCalled()
    expect(s.destroy).not.toHaveBeenCalled()
    await querySnowflakeStorage(signed)
    expect(s.execute).toHaveBeenCalledTimes(2)
  },
)

it('does not replay a failed storage write and destroys its connection', async () => {
  await querySnowflakeStorage(signed)
  s.execute.mockClear()
  s.fail = true
  const sql =
    "PUT 'file:///tmp/photo.jpg' '@DB.RAW.FILES/originals/' AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
  await expect(querySnowflakeStorage(sql)).rejects.toThrow('connection failed')
  expect(s.execute).toHaveBeenCalledTimes(1)
  expect(s.execute.mock.calls[0][0].sqlText).toBe(sql)
  expect(s.destroy).toHaveBeenCalledTimes(1)
})

it('permits bounded scalar signing batches but refuses scans and statement injection', async () => {
  const col = (i: number) =>
    `GET_PRESIGNED_URL(@DB.RAW.FILES, 'thumbnails/a,b.jpg', 300) AS URL${i}`
  await querySnowflakeStorage('SELECT ' + Array.from({ length: 32 }, (_, i) => col(i)).join(', '))
  for (const sql of [
    'SELECT ' + Array.from({ length: 33 }, (_, i) => col(i)).join(', '),
    'SELECT ' + col(0) + ' FROM photos',
    'SELECT ' + col(0) + ', CURRENT_USER() AS URL1',
    'SELECT ' + col(0) + '; USE WAREHOUSE COMPUTE_WH',
  ])
    await expect(querySnowflakeStorage(sql)).rejects.toThrow('only accepts')
  await closePool()
  s.warehouse = 'COMPUTE_WH'
  await expect(querySnowflakeStorage('SELECT ' + col(0))).rejects.toThrow('refusing operation')
})

it('reuses validation until an operation fails, then validates again before proceeding', async () => {
  await querySnowflakeStorage(signed)
  await querySnowflakeStorage(signed)
  expect(s.execute).toHaveBeenCalledTimes(3)
  s.fail = true
  await expect(querySnowflakeStorage(signed)).rejects.toThrow('connection failed')
  s.warehouse = 'COMPUTE_WH'
  await expect(querySnowflakeStorage(signed)).rejects.toThrow('refusing operation')
  s.warehouse = null
  await querySnowflakeStorage(signed)
  expect(
    s.execute.mock.calls.filter(([o]) => o.sqlText.includes('CURRENT_WAREHOUSE')),
  ).toHaveLength(3)
})
