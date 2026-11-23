import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
})
it('coalesces opening the upload page and concurrent files into one startup request', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ready: true }))
  vi.stubGlobal('fetch', fetcher)
  const { ensureUploadPoolReady } = await import('@/lib/upload/upload-pool-client')
  await Promise.all([ensureUploadPoolReady(), ensureUploadPoolReady(), ensureUploadPoolReady()])
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][1].method).toBe('POST')
})
it('an open dialog issues no wakeups after startup completes', async () => {
  vi.useFakeTimers()
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ ready: false, phase: 'resuming' }))
    .mockResolvedValueOnce(Response.json({ ready: true, phase: 'pool' }))
  vi.stubGlobal('fetch', fetcher)
  const { ensureUploadPoolReady } = await import('@/lib/upload/upload-pool-client')
  const ready = ensureUploadPoolReady()
  await vi.advanceTimersByTimeAsync(2000)
  await ready
  await vi.advanceTimersByTimeAsync(11 * 60 * 1000)
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'GET'])
  fetcher.mockResolvedValueOnce(Response.json({ ready: true }))
  await ensureUploadPoolReady()
  expect(fetcher.mock.calls.at(-1)?.[1].method).toBe('POST')
})
it('canceling one waiting file does not cancel startup for another', async () => {
  let finish!: (r: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    ),
  )
  const { ensureUploadPoolReady } = await import('@/lib/upload/upload-pool-client')
  const controller = new AbortController()
  const canceled = ensureUploadPoolReady(controller.signal)
  const other = ensureUploadPoolReady()
  controller.abort()
  await expect(canceled).rejects.toMatchObject({ name: 'AbortError' })
  finish(Response.json({ ready: true }))
  await other
})
it('holds concurrent files through HTML deployment failures and retries startup', async () => {
  vi.useFakeTimers()
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('<html>Restarting</html>', { status: 503 }))
    .mockRejectedValueOnce(new TypeError('Load failed'))
    .mockResolvedValueOnce(Response.json({ ready: true }))
  vi.stubGlobal('fetch', fetcher)
  const { ensureUploadPoolReady } = await import('@/lib/upload/upload-pool-client')
  const all = Promise.all([ensureUploadPoolReady(), ensureUploadPoolReady()])
  await vi.advanceTimersByTimeAsync(12000)
  await all
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'POST', 'POST'])
})
it('retries malformed successful responses while polling without another wakeup', async () => {
  vi.useFakeTimers()
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ ready: false, phase: 'resuming' }))
    .mockResolvedValueOnce(new Response('<html>Unavailable</html>'))
    .mockResolvedValueOnce(Response.json({ ready: true }))
  vi.stubGlobal('fetch', fetcher)
  const { ensureUploadPoolReady } = await import('@/lib/upload/upload-pool-client')
  const ready = ensureUploadPoolReady()
  await vi.advanceTimersByTimeAsync(6000)
  await ready
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'GET', 'GET'])
})
it('pauses for expired authentication rather than retrying or parsing HTML', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('Sign in required', { status: 401 }))
  vi.stubGlobal('fetch', fetcher)
  const { ensureUploadPoolReady } = await import('@/lib/upload/upload-pool-client')
  await expect(ensureUploadPoolReady()).rejects.toMatchObject({
    authenticationRequired: true,
    accessIssue: 'authentication',
  })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('bounds repeated temporary failures by the startup deadline', async () => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 502 }))),
  )
  const { ensureUploadPoolReady } = await import('@/lib/upload/upload-pool-client')
  const outcome = expect(ensureUploadPoolReady()).rejects.toThrow('startup timed out')
  await vi.advanceTimersByTimeAsync(21 * 60 * 1000)
  await outcome
})
