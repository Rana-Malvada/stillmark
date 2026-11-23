import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => vi.fn())
vi.mock('@/lib/snowflake', () => ({ querySnowflakeStorage: storage }))
vi.mock('@/lib/snowflake/media-stage', () => ({ mediaStage: () => '@TEST.RAW.FILES' }))
beforeEach(() => {
  vi.resetModules()
  storage.mockReset()
  storage.mockResolvedValue([{ URL: 'https://example.test/fresh' }])
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
it('coalesces matching misses, distinguishes expiration settings and retries failures', async () => {
  const { getPresignedUrl } = await import('../lib/media/image-urls')
  await Promise.all([getPresignedUrl('thumbnails/a.jpg'), getPresignedUrl('thumbnails/a.jpg')])
  expect(storage).toHaveBeenCalledTimes(1)
  await getPresignedUrl('thumbnails/a.jpg')
  expect(storage).toHaveBeenCalledTimes(1)
  await getPresignedUrl('thumbnails/a.jpg', 300)
  expect(storage).toHaveBeenCalledTimes(2)
  storage.mockRejectedValueOnce(Error('unavailable'))
  await expect(getPresignedUrl('thumbnails/b.jpg')).rejects.toThrow('unavailable')
  await expect(getPresignedUrl('thumbnails/b.jpg')).resolves.toBe('https://example.test/fresh')
})
it('does not let invalidated in-flight work replace newer URLs', async () => {
  let finish!: (value: { URL: string }[]) => void
  storage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const { getPresignedUrl, invalidateMediaUrl } = await import('../lib/media/image-urls')
  const first = getPresignedUrl('thumbnails/a.jpg')
  invalidateMediaUrl('thumbnails/a.jpg')
  await expect(getPresignedUrl('thumbnails/a.jpg')).resolves.toBe('https://example.test/fresh')
  finish([{ URL: 'https://example.test/stale' }])
  await first
  await expect(getPresignedUrl('thumbnails/a.jpg')).resolves.toBe('https://example.test/fresh')
  expect(storage).toHaveBeenCalledTimes(2)
})
it('refreshes before URL expiry and never sends invalid paths to storage', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(100000)
  const { getPresignedUrl } = await import('../lib/media/image-urls')
  await getPresignedUrl('thumbnails/a.jpg', 60)
  vi.advanceTimersByTime(30000)
  await getPresignedUrl('thumbnails/a.jpg', 60)
  expect(storage).toHaveBeenCalledTimes(2)
  await expect(getPresignedUrl('../private')).rejects.toThrow()
  expect(storage).toHaveBeenCalledTimes(2)
})

it('batches distinct cache misses while retaining duplicate coalescing and literal escaping', async () => {
  vi.stubEnv('MEDIA_SIGNING_BATCH_ENABLED', 'true')
  storage.mockResolvedValueOnce([
    { URL0: 'https://example.test/a', URL1: 'https://example.test/b' },
  ])
  const { getPresignedUrl } = await import('../lib/media/image-urls')
  expect(
    await Promise.all([
      getPresignedUrl("thumbnails/a'b.jpg"),
      getPresignedUrl('display/b.jpg'),
      getPresignedUrl("thumbnails/a'b.jpg"),
    ]),
  ).toEqual(['https://example.test/a', 'https://example.test/b', 'https://example.test/a'])
  expect(storage).toHaveBeenCalledTimes(1)
  expect(storage.mock.calls[0][0]).toBe(
    "SELECT GET_PRESIGNED_URL(@TEST.RAW.FILES, 'thumbnails/a''b.jpg', 3600) AS URL0, GET_PRESIGNED_URL(@TEST.RAW.FILES, 'display/b.jpg', 3600) AS URL1",
  )
})
