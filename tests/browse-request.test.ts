import { afterEach, expect, it, vi } from 'vitest'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { config } from '../proxy'
import { withBrowseRequest } from '../lib/browse-request'
import { databaseContext } from '../lib/database/database-context'

afterEach(() => vi.unstubAllEnvs())
it.each([
  '/api/events',
  '/api/events?paged=true',
  '/api/events/123',
  '/api/photos/123',
  '/api/images?path=thumb',
])('avoids the redundant proxy pass for %s', (url) => {
  expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false)
})
it.each([
  '/api/events/123/share',
  '/api/events/abc',
  '/api/photos/bulk',
  '/api/photos/download',
  '/api/images/extra',
  '/api/upload/complete',
  '/',
  '/share/abc',
  '/api/access',
])('retains the proxy for %s', (url) => {
  expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true)
})
it('blocks browse handlers on an upload-only service before any work', async () => {
  vi.stubEnv('UPLOAD_SERVICE_ONLY', 'true')
  const work = vi.fn()
  const response = await withBrowseRequest(work)(new Request('https://app/api/events'))
  expect(response.status).toBe(404)
  expect(work).not.toHaveBeenCalled()
})
it('keeps concurrent request identities separate', async () => {
  const handler = withBrowseRequest(async (request) => {
    await new Promise((resolve) => setTimeout(resolve, 1))
    const ctx = databaseContext.getStore()
    expect(ctx?.kind).toBe('request')
    if (ctx?.kind === 'request')
      expect(ctx.requestBinding?.target).toBe(new URL(request.url).pathname)
    return new Response(null, { status: 204 })
  })
  await Promise.all([1, 2].map((id) => handler(new Request(`https://app/api/photos/${id}`))))
  expect(databaseContext.getStore()).toBeUndefined()
})
