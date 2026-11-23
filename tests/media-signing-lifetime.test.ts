import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => vi.fn())
vi.mock('@/lib/snowflake', () => ({ querySnowflakeStorage: storage }))
vi.mock('@/lib/snowflake/media-stage', () => ({ mediaStage: () => '@TEST.RAW.FILES' }))

beforeEach(() => {
  vi.resetModules()
  storage.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

it.each(['before', 'during'])('isolates distinct signing callers aborted %s SQL', async (when) => {
  vi.useFakeTimers()
  const { databaseContext, databaseSignal } = await import('../lib/database/database-context')
  const { MediaSigningBatch } = await import('../lib/media/media-signing-batch')
  let finish!: (rows: Record<string, string>[]) => void
  let operationSignal: AbortSignal | undefined
  let operationContext: unknown
  const query = vi.fn(() => {
    operationSignal = databaseSignal()
    operationContext = databaseContext.getStore()
    return new Promise<Record<string, string>[]>((resolve) => {
      finish = resolve
    })
  })
  const batch = new MediaSigningBatch(query)
  const a = new AbortController()
  const b = new AbortController()
  const first = databaseContext.run({ kind: 'request', signal: a.signal }, () => batch.sign('a'))
  const second = databaseContext.run({ kind: 'request', signal: b.signal }, () => batch.sign('b'))
  const settled = Promise.allSettled([first, second])
  if (when === 'before') a.abort(new Error('caller A left'))
  await vi.advanceTimersByTimeAsync(2)
  if (when === 'during') a.abort(new Error('caller A left'))
  finish(
    when === 'before'
      ? [{ URL0: 'https://example.test/b' }]
      : [{ URL0: 'https://example.test/a', URL1: 'https://example.test/b' }],
  )
  const result = await settled
  expect(result[0]).toMatchObject({ status: 'rejected', reason: { message: 'caller A left' } })
  expect(result[1]).toEqual({ status: 'fulfilled', value: 'https://example.test/b' })
  expect(operationContext).toMatchObject({ kind: 'anonymous' })
  expect(operationSignal).toBeDefined()
  expect(operationSignal).not.toBe(a.signal)
  expect(operationSignal).not.toBe(b.signal)
  expect(operationSignal?.aborted).toBe(false)
})

it.each([false, true])(
  'keeps same-expression image subscribers independent (batch=%s)',
  async (batched) => {
    vi.stubEnv('MEDIA_SIGNING_BATCH_ENABLED', String(batched))
    const { databaseContext, databaseSignal } = await import('../lib/database/database-context')
    const { getPresignedUrl } = await import('../lib/media/image-urls')
    let finish!: (rows: Record<string, string>[]) => void
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    let operationSignal: AbortSignal | undefined
    storage.mockImplementation(() => {
      operationSignal = databaseSignal()
      started()
      return new Promise<Record<string, string>[]>((resolve) => {
        finish = resolve
      })
    })
    const a = new AbortController()
    const b = new AbortController()
    const first = databaseContext.run({ kind: 'request', signal: a.signal }, () =>
      getPresignedUrl('thumbnails/same.jpg'),
    )
    const second = databaseContext.run({ kind: 'request', signal: b.signal }, () =>
      getPresignedUrl('thumbnails/same.jpg'),
    )
    const settled = Promise.allSettled([first, second])
    await startedPromise
    a.abort(new Error('caller A left'))
    expect(operationSignal?.aborted).toBe(false)
    finish([{ [batched ? 'URL0' : 'URL']: 'https://example.test/same' }])
    const result = await settled
    expect(result[0]).toMatchObject({ status: 'rejected', reason: { message: 'caller A left' } })
    expect(result[1]).toEqual({ status: 'fulfilled', value: 'https://example.test/same' })
    expect(storage).toHaveBeenCalledTimes(1)
    await expect(getPresignedUrl('thumbnails/same.jpg')).resolves.toBe('https://example.test/same')
    expect(storage).toHaveBeenCalledTimes(1)
  },
)
