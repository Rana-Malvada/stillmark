import { afterEach, expect, it, vi } from 'vitest'
import { withSearchRequest } from '@/lib/search/search-request'
import { databaseSignal } from '@/lib/database/database-context'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
it('bounds the entire request and passes the same signal through request and database context', async () => {
  vi.useFakeTimers()
  vi.stubEnv('SEARCH_REQUEST_TIMEOUT_MS', '100')
  let observed: AbortSignal | undefined
  const handler = vi.fn((request: Request) => {
    observed = databaseSignal()
    expect(request.signal.aborted).toBe(false)
    return new Promise<Response>((_, reject) =>
      request.signal.addEventListener('abort', () => reject(request.signal.reason)),
    )
  })
  const response = withSearchRequest(handler)(new Request('https://app/api/search'))
  await vi.advanceTimersByTimeAsync(100)
  expect(observed?.aborted).toBe(true)
  expect((await response).status).toBe(504)
  expect((await response).headers.get('retry-after')).toBe('1')
})
it('settles disconnected subscribers without waiting for an uncooperative handler', async () => {
  const controller = new AbortController()
  const response = withSearchRequest(() => new Promise(() => {}))(
    new Request('https://app/api/search', { signal: controller.signal }),
  )
  controller.abort()
  expect((await response).status).toBe(499)
})
it('does not start work or create an unhandled rejection for an already disconnected request', async () => {
  const controller = new AbortController()
  controller.abort()
  const handler = vi.fn(async () => Response.json({ ok: true }))
  expect(
    (
      await withSearchRequest(handler)(
        new Request('https://app/api/search', { signal: controller.signal }),
      )
    ).status,
  ).toBe(499)
  expect(handler).not.toHaveBeenCalled()
})
