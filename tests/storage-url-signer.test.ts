import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/snowflake', () => ({ querySnowflakeStorage: vi.fn() }))
import { StorageUrlSigner } from '@/lib/snowflake/storage-url-signer'

afterEach(() => vi.useRealTimers())
it('coalesces requests and expires with a safety margin measured from request start', async () => {
  vi.useFakeTimers()
  const sign = vi.fn(async () => 'url')
  const signer = new StorageUrlSigner(sign)
  await Promise.all([signer.get('a', 300), signer.get('a', 300)])
  await signer.get('a', 300)
  expect(sign).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(270000)
  await signer.get('a', 300)
  expect(sign).toHaveBeenCalledTimes(2)
})

it('cancels shared signing only when the last subscriber leaves and does not cache a late result', async () => {
  let finish!: (url: string) => void
  let operationSignal!: AbortSignal
  const sign = vi.fn((_: string, signal: AbortSignal) => {
    operationSignal = signal
    return new Promise<string>((resolve) => {
      finish = resolve
    })
  })
  const signer = new StorageUrlSigner(sign)
  const a = new AbortController()
  const b = new AbortController()
  const pending = Promise.allSettled([
    signer.get('a', 300, a.signal),
    signer.get('a', 300, b.signal),
  ])
  a.abort()
  expect(operationSignal.aborted).toBe(false)
  b.abort()
  expect(operationSignal.aborted).toBe(true)
  expect((await pending).every((result) => result.status === 'rejected')).toBe(true)
  finish('late')
  await Promise.resolve()
  sign.mockResolvedValueOnce('fresh')
  await expect(signer.get('a', 300)).resolves.toBe('fresh')
  expect(sign).toHaveBeenCalledTimes(2)
})

it('bounds signing lifetime and pending entries, and recovers after an operation expires', async () => {
  vi.useFakeTimers()
  const sign = vi
    .fn()
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValue('fresh')
  const signer = new StorageUrlSigner(sign, 10, 10000, { timeoutMs: 20, maxPending: 1 })
  const timedOut = expect(signer.get('a', 300)).rejects.toThrow('deadline exceeded')
  await expect(signer.get('b', 300)).rejects.toThrow('queue is full')
  await vi.advanceTimersByTimeAsync(20)
  await timedOut
  await expect(signer.get('a', 300)).resolves.toBe('fresh')
})

it('bounds coalesced subscribers as well as distinct signing operations', async () => {
  let finish!: (url: string) => void
  const sign = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve
      }),
  )
  const signer = new StorageUrlSigner(sign, 10, 10000, { maxPending: 2 })
  const controller = new AbortController()
  const first = Promise.allSettled([signer.get('a', 300, controller.signal)])
  const second = signer.get('a', 300)
  await expect(signer.get('a', 300)).rejects.toThrow('queue is full')
  controller.abort()
  expect((await first)[0].status).toBe('rejected')
  const third = signer.get('a', 300)
  finish('url')
  expect(await Promise.all([second, third])).toEqual(['url', 'url'])
  expect(sign).toHaveBeenCalledTimes(1)
})
it('retries failures and evicts older URLs within its entry budget', async () => {
  const sign = vi.fn().mockRejectedValueOnce(Error('failed')).mockResolvedValue('url')
  const signer = new StorageUrlSigner(sign, 1)
  await expect(signer.get('a', 300)).rejects.toThrow('failed')
  await signer.get('a', 300)
  await signer.get('b', 300)
  await signer.get('a', 300)
  expect(sign).toHaveBeenCalledTimes(4)
})
it('does not repopulate an invalidated URL from an outstanding request', async () => {
  let resolve!: (url: string) => void
  const sign = vi
    .fn()
    .mockImplementationOnce(() => new Promise<string>((r) => (resolve = r)))
    .mockResolvedValue('new')
  const signer = new StorageUrlSigner(sign)
  const old = signer.get('a', 300)
  signer.invalidate('a')
  resolve('old')
  await old
  expect(await signer.get('a', 300)).toBe('new')
  expect(sign).toHaveBeenCalledTimes(2)
})
