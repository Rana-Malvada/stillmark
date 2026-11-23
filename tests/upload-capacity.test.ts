import { afterEach, expect, it, vi } from 'vitest'
import {
  uploadActiveOperations,
  withUploadChunkCapacity,
  withUploadClaimCapacity,
  withUploadCompletionCapacity,
} from '../lib/upload/upload-capacity'

afterEach(() => {
  expect(uploadActiveOperations()).toBe(0)
  vi.unstubAllEnvs()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
it('empty polls reserve admission without reporting active work or overclaiming', async () => {
  vi.stubEnv('UPLOAD_COMPLETIONS_PER_INSTANCE', '1')
  const poll = deferred<undefined>()
  const process = vi.fn()
  const pending = withUploadClaimCapacity(() => poll.promise, process)
  expect(uploadActiveOperations()).toBe(0)
  const extraClaim = vi.fn()
  await expect(withUploadClaimCapacity(extraClaim, process)).rejects.toThrow('busy')
  expect(extraClaim).not.toHaveBeenCalled()
  poll.resolve(undefined)
  await pending
  expect(process).not.toHaveBeenCalled()
  await withUploadCompletionCapacity(async () => expect(uploadActiveOperations()).toBe(1))
})
it('counts real processing and chunks, and releases capacity after errors', async () => {
  vi.stubEnv('UPLOAD_COMPLETIONS_PER_INSTANCE', '1')
  const processing = deferred<void>()
  const started = deferred<void>()
  const pending = withUploadClaimCapacity(
    async () => ({ id: 1 }),
    async () => {
      started.resolve()
      await processing.promise
      throw Error('processing failed')
    },
  )
  await started.promise
  expect(uploadActiveOperations()).toBe(1)
  await withUploadChunkCapacity(async () => expect(uploadActiveOperations()).toBe(2))
  const rejected = expect(pending).rejects.toThrow('processing failed')
  processing.resolve()
  await rejected
  await expect(
    withUploadClaimCapacity(async () => {
      throw Error('claim failed')
    }, vi.fn()),
  ).rejects.toThrow('claim failed')
  await expect(
    withUploadCompletionCapacity(async () => {
      throw Error('sync failed')
    }),
  ).rejects.toThrow('sync failed')
  await withUploadCompletionCapacity(async () => expect(uploadActiveOperations()).toBe(1))
})

it('queues chunks FIFO without reading bodies and releases slots on cancellation', async () => {
  vi.stubEnv('UPLOAD_CHUNKS_PER_INSTANCE', '1')
  const hold = deferred<void>()
  const first = withUploadChunkCapacity(() => hold.promise)
  const order: number[] = []
  const abort = new AbortController()
  const cancelledBody = vi.fn()
  const cancelled = withUploadChunkCapacity(cancelledBody, { waitMs: 1000, signal: abort.signal })
  const rejected = expect(cancelled).rejects.toThrow()
  const second = withUploadChunkCapacity(
    async () => {
      order.push(2)
    },
    { waitMs: 1000 },
  )
  const third = withUploadChunkCapacity(
    async () => {
      order.push(3)
    },
    { waitMs: 1000 },
  )
  expect(order).toEqual([])
  expect(uploadActiveOperations()).toBe(1)
  abort.abort()
  await rejected
  hold.resolve()
  await Promise.all([first, second, third])
  expect(cancelledBody).not.toHaveBeenCalled()
  expect(order).toEqual([2, 3])
})
it('bounds waiting requests and expires them without reading their bodies', async () => {
  vi.stubEnv('UPLOAD_CHUNKS_PER_INSTANCE', '1')
  const hold = deferred<void>()
  const first = withUploadChunkCapacity(() => hold.promise)
  const bodies = vi.fn()
  const waits = Array.from({ length: 16 }, () =>
    expect(withUploadChunkCapacity(bodies, { waitMs: 20 })).rejects.toMatchObject({ status: 429 }),
  )
  await expect(withUploadChunkCapacity(bodies, { waitMs: 1000 })).rejects.toMatchObject({
    status: 429,
  })
  await Promise.all(waits)
  expect(bodies).not.toHaveBeenCalled()
  hold.resolve()
  await first
  await expect(withUploadChunkCapacity(async () => 'ok', { waitMs: 1000 })).resolves.toBe('ok')
})
