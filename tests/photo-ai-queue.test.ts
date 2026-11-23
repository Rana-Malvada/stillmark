import { beforeEach, expect, it, vi } from 'vitest'

const batch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/ai-categorize', () => ({
  processAllUncategorized: batch,
}))
import { drainPhotoAiQueue } from '@/lib/photos/photo-ai-queue'

const empty = { processed: 0, errors: [] }
beforeEach(() => batch.mockReset())
it('drains more than one bounded batch immediately and stops when empty', async () => {
  batch
    .mockResolvedValueOnce({ processed: 20, errors: [] })
    .mockResolvedValueOnce({ processed: 21, errors: [] })
    .mockResolvedValue(empty)
  await drainPhotoAiQueue()
  expect(batch).toHaveBeenCalledTimes(3)
})
it('coalesces concurrent upload wakes without losing work arriving during an empty batch', async () => {
  let finish!: (value: typeof empty) => void
  batch
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValueOnce({ processed: 1, errors: [] })
    .mockResolvedValue(empty)
  const first = drainPhotoAiQueue()
  await Promise.resolve()
  const second = drainPhotoAiQueue()
  expect(second).toBe(first)
  finish(empty)
  await first
  expect(batch).toHaveBeenCalledTimes(3)
})
it('continues past failed rows but stops when only delayed retries remain', async () => {
  batch
    .mockResolvedValueOnce({ processed: 0, errors: [{ photoId: 1, error: 'retry later' }] })
    .mockResolvedValue(empty)
  await drainPhotoAiQueue()
  expect(batch).toHaveBeenCalledTimes(2)
})
it('stops on an infrastructure failure and can recover on the next wake', async () => {
  batch.mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue(empty)
  await expect(drainPhotoAiQueue()).rejects.toThrow('database unavailable')
  expect(batch).toHaveBeenCalledTimes(1)
  await drainPhotoAiQueue()
  expect(batch).toHaveBeenCalledTimes(2)
})
it('does not spin when another instance holds the batch lock', async () => {
  batch.mockResolvedValue(empty)
  await drainPhotoAiQueue()
  expect(batch).toHaveBeenCalledTimes(1)
})
