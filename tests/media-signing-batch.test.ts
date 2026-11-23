import { afterEach, expect, it, vi } from 'vitest'
import { MediaSigningBatch } from '../lib/media/media-signing-batch'
import { databaseSignal } from '../lib/database/database-context'

afterEach(() => vi.useRealTimers())
it('batches distinct misses, preserves their mapping and caps concurrent statements', async () => {
  vi.useFakeTimers()
  const releases: (() => void)[] = []
  let active = 0
  let peak = 0
  const query = vi.fn(async (sql: string) => {
    active++
    peak = Math.max(active, peak)
    await new Promise<void>((resolve) => releases.push(resolve))
    active--
    return [
      Object.fromEntries(
        [...sql.matchAll(/item(\d+) AS URL(\d+)/g)].map((m) => [
          'URL' + m[2],
          'https://example.test/' + m[1],
        ]),
      ),
    ]
  })
  const batch = new MediaSigningBatch(query)
  const all = Promise.all(Array.from({ length: 140 }, (_, i) => batch.sign('item' + i)))
  await vi.advanceTimersByTimeAsync(2)
  expect(query).toHaveBeenCalledTimes(4)
  expect(peak).toBe(4)
  releases.splice(0).forEach((release) => release())
  await vi.advanceTimersByTimeAsync(2)
  expect(query).toHaveBeenCalledTimes(5)
  releases.splice(0).forEach((release) => release())
  expect(await all).toEqual(Array.from({ length: 140 }, (_, i) => 'https://example.test/' + i))
})

it('removes canceled waiting work and only aborts active SQL after all subscribers cancel', async () => {
  vi.useFakeTimers()
  let activeSignal: AbortSignal | undefined
  const query = vi
    .fn()
    .mockImplementationOnce(() => {
      activeSignal = databaseSignal()
      return new Promise((_, reject) =>
        activeSignal!.addEventListener('abort', () => reject(activeSignal!.reason), { once: true }),
      )
    })
    .mockResolvedValue([{ URL0: 'https://example.test/recovered' }])
  const batch = new MediaSigningBatch(query)
  const queued = new AbortController()
  const skipped = Promise.allSettled([batch.sign('skipped', queued.signal)])
  queued.abort()
  await vi.advanceTimersByTimeAsync(2)
  expect((await skipped)[0].status).toBe('rejected')
  expect(query).not.toHaveBeenCalled()
  const a = new AbortController()
  const b = new AbortController()
  const pending = Promise.allSettled([batch.sign('a', a.signal), batch.sign('b', b.signal)])
  await vi.advanceTimersByTimeAsync(2)
  a.abort()
  expect(activeSignal?.aborted).toBe(false)
  b.abort()
  expect(activeSignal?.aborted).toBe(true)
  expect((await pending).every((result) => result.status === 'rejected')).toBe(true)
  const recovered = batch.sign('recovered')
  await vi.advanceTimersByTimeAsync(2)
  await expect(recovered).resolves.toBe('https://example.test/recovered')
})

it('expires both active and queued items without opening more SQL until cancellation settles', async () => {
  vi.useFakeTimers()
  const finish: (() => void)[] = []
  const signals: AbortSignal[] = []
  const query = vi.fn(() => {
    signals.push(databaseSignal()!)
    return new Promise<Record<string, string>[]>((resolve) => finish.push(() => resolve([])))
  })
  const batch = new MediaSigningBatch(query, 20)
  const pending = Promise.allSettled(Array.from({ length: 140 }, (_, i) => batch.sign('item' + i)))
  await vi.advanceTimersByTimeAsync(20)
  expect(
    (await pending).every(
      (result) => result.status === 'rejected' && result.reason.name === 'TimeoutError',
    ),
  ).toBe(true)
  expect(query).toHaveBeenCalledTimes(4)
  expect(signals.every((signal) => signal.aborted)).toBe(true)
  // Even an uncooperative transport cannot cause more than four active batches.
  const later = Promise.allSettled([batch.sign('later')])
  await vi.advanceTimersByTimeAsync(20)
  expect((await later)[0].status).toBe('rejected')
  expect(query).toHaveBeenCalledTimes(4)
  finish.forEach((resolve) => resolve())
  await vi.advanceTimersByTimeAsync(1)
  query.mockResolvedValueOnce([{ URL0: 'https://example.test/recovered' }])
  const recovered = batch.sign('recovered')
  await vi.advanceTimersByTimeAsync(2)
  await expect(recovered).resolves.toBe('https://example.test/recovered')
})
it('rejects a failed or malformed batch and permits a subsequent retry', async () => {
  vi.useFakeTimers()
  const query = vi
    .fn()
    .mockRejectedValueOnce(Error('offline'))
    .mockResolvedValueOnce([{ URL0: 'https://example.test/ok' }])
    .mockResolvedValueOnce([{ URL0: 'http://invalid' }])
  const batch = new MediaSigningBatch(query)
  const failed = Promise.allSettled([batch.sign('a'), batch.sign('b')])
  await vi.advanceTimersByTimeAsync(2)
  expect((await failed).every((x) => x.status === 'rejected')).toBe(true)
  const retry = batch.sign('a')
  await vi.advanceTimersByTimeAsync(2)
  await expect(retry).resolves.toBe('https://example.test/ok')
  const invalid = Promise.allSettled([batch.sign('b')])
  await vi.advanceTimersByTimeAsync(2)
  expect((await invalid)[0].status).toBe('rejected')
})
it('bounds the waiting queue', async () => {
  vi.useFakeTimers()
  const query = vi.fn(async () => {
    throw Error('unavailable')
  })
  const batch = new MediaSigningBatch(query)
  const pending = Promise.allSettled(Array.from({ length: 4096 }, () => batch.sign('a')))
  await expect(batch.sign('overflow')).rejects.toThrow('queue is full')
  await vi.runAllTimersAsync()
  expect((await pending).length).toBe(4096)
})
