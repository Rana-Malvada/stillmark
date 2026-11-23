import { afterEach, expect, it, vi } from 'vitest'
import { withPublicRequest } from '@/lib/public-request'
import {
  databaseContext,
  databaseSignal,
  withPublicDatabase,
} from '@/lib/database/database-context'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
it('cancels public work within the header budget without constructing a user identity', async () => {
  vi.useFakeTimers()
  vi.stubEnv('BROWSE_REQUEST_TIMEOUT_MS', '100')
  let signal: AbortSignal | undefined
  const response = withPublicRequest(async (request) => {
    expect(databaseContext.getStore()).toBeUndefined()
    return withPublicDatabase(
      'a'.repeat(64),
      async () => {
        signal = databaseSignal()
        await new Promise((_, reject) =>
          signal?.addEventListener('abort', () => reject(signal?.reason), { once: true }),
        )
        return new Response('unreachable')
      },
      request.signal,
    )
  })(new Request('https://app/share/secret'))
  await vi.advanceTimersByTimeAsync(100)
  const result = await response
  expect(result.status).toBe(504)
  expect(result.headers.get('Cache-Control')).toBe('private, no-store')
  expect(result.headers.get('Referrer-Policy')).toBe('no-referrer')
  expect(signal?.aborted).toBe(true)
})
it('keeps a returned download alive past the header budget but honors client disconnect', async () => {
  vi.useFakeTimers()
  vi.stubEnv('BROWSE_REQUEST_TIMEOUT_MS', '100')
  const controller = new AbortController()
  let signal!: AbortSignal
  const result = await withPublicRequest(async (request) => {
    signal = request.signal
    return new Response('download', { status: 206, headers: { 'Content-Range': 'bytes 0-7/8' } })
  })(new Request('https://app/share/secret/download', { signal: controller.signal }))
  await vi.advanceTimersByTimeAsync(1000)
  expect(signal.aborted).toBe(false)
  expect(result.status).toBe(206)
  expect(result.headers.get('Content-Range')).toBe('bytes 0-7/8')
  expect(await result.text()).toBe('download')
  controller.abort()
  expect(signal.aborted).toBe(true)
})
it('does not expose public browsing on upload-only services', async () => {
  vi.stubEnv('UPLOAD_SERVICE_ONLY', 'true')
  const handler = vi.fn()
  expect((await withPublicRequest(handler)(new Request('https://app/share/secret'))).status).toBe(
    404,
  )
  expect(handler).not.toHaveBeenCalled()
})
