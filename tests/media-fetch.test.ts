import { afterEach, expect, it, vi } from 'vitest'
import { fetchMedia } from '@/lib/media/media-fetch'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('does not abort an active video body after two minutes, but follows viewer cancellation', async () => {
  vi.useFakeTimers()
  let upstreamSignal: AbortSignal | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      upstreamSignal = options.signal
      return new Response(new ReadableStream())
    }),
  )
  const c = new AbortController()
  await fetchMedia('https://storage.example/file', undefined, c.signal)
  await vi.advanceTimersByTimeAsync(180000)
  expect(upstreamSignal?.aborted).toBe(false)
  c.abort()
  expect(upstreamSignal?.aborted).toBe(true)
})
it('still aborts a storage server that never sends response headers', async () => {
  vi.useFakeTimers()
  let upstreamSignal: AbortSignal | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn((_url, options) => {
      upstreamSignal = options.signal
      return new Promise(() => {})
    }),
  )
  void fetchMedia('https://storage.example/file', undefined, new AbortController().signal)
  await vi.advanceTimersByTimeAsync(30001)
  expect(upstreamSignal?.aborted).toBe(true)
})

it('retries a reset socket once before headers and preserves range headers', async () => {
  const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
  const fetch = vi.fn().mockRejectedValueOnce(reset).mockResolvedValue(new Response('ok'))
  vi.stubGlobal('fetch', fetch)
  const headers = { Range: 'bytes=0-10' }
  expect(
    await (
      await fetchMedia('https://storage.example/file', headers, new AbortController().signal)
    ).text(),
  ).toBe('ok')
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls[1][1].headers).toEqual(headers)
})
it('bounds repeated socket failures and does not retry unrelated errors', async () => {
  for (const code of ['UND_ERR_SOCKET', 'EPIPE', 'CERT_HAS_EXPIRED']) {
    const error = Object.assign(new TypeError('fetch failed'), { cause: { code } })
    const fetch = vi.fn().mockRejectedValue(error)
    vi.stubGlobal('fetch', fetch)
    await expect(
      fetchMedia('https://storage.example/file', undefined, new AbortController().signal),
    ).rejects.toBe(error)
    expect(fetch).toHaveBeenCalledTimes(code === 'CERT_HAS_EXPIRED' ? 1 : 2)
  }
})
it('never retries HTTP errors or cancellation', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }))
  vi.stubGlobal('fetch', fetch)
  expect(
    (await fetchMedia('https://storage.example/file', undefined, new AbortController().signal))
      .status,
  ).toBe(403)
  expect(fetch).toHaveBeenCalledTimes(1)
  const c = new AbortController()
  fetch.mockImplementationOnce(async () => {
    c.abort()
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
  })
  await expect(fetchMedia('https://storage.example/file', undefined, c.signal)).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(2)
})
it('recovers a real upstream socket reset before any response headers', async () => {
  const { createServer } = await import('node:http')
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    if (requests === 1) req.socket.destroy()
    else res.end('image bytes')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    const response = await fetchMedia(
      `http://127.0.0.1:${address.port}/image`,
      undefined,
      new AbortController().signal,
    )
    expect(await response.text()).toBe('image bytes')
    expect(requests).toBe(2)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
