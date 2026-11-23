import { afterEach, expect, it, vi } from 'vitest'
import { acquireDatabaseClient } from '@/lib/database/postgres-admission'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
it('rejects a full queue without opening another connection', async () => {
  vi.stubEnv('PG_MAX_PENDING_CHECKOUTS', '2')
  const pool = { waitingCount: 2, connect: vi.fn() }
  await expect(acquireDatabaseClient(pool)).rejects.toMatchObject({ status: 503 })
  expect(pool.connect).not.toHaveBeenCalled()
})
it('returns a late connection after the request deadline', async () => {
  vi.useFakeTimers()
  vi.stubEnv('PG_CHECKOUT_TIMEOUT_MS', '100')
  let deliver!: (value: { release: () => void }) => void
  const release = vi.fn()
  const result = acquireDatabaseClient({
    waitingCount: 0,
    connect: () =>
      new Promise<{ release: () => void }>((resolve) => {
        deliver = resolve
      }),
  })
  const rejected = expect(result).rejects.toMatchObject({ status: 503 })
  await vi.advanceTimersByTimeAsync(100)
  await rejected
  deliver({ release })
  await Promise.resolve()
  expect(release).toHaveBeenCalledOnce()
})
it('aborting while waiting returns a later connection and preserves successful ownership', async () => {
  let deliver!: (value: { release: () => void }) => void
  const controller = new AbortController()
  const release = vi.fn()
  const result = acquireDatabaseClient(
    {
      waitingCount: 0,
      connect: () =>
        new Promise<{ release: () => void }>((resolve) => {
          deliver = resolve
        }),
    },
    controller.signal,
  )
  controller.abort()
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  deliver({ release })
  await Promise.resolve()
  expect(release).toHaveBeenCalledOnce()
  const client = { release: vi.fn() }
  expect(await acquireDatabaseClient({ waitingCount: 0, connect: async () => client })).toBe(client)
  expect(client.release).not.toHaveBeenCalled()
})
