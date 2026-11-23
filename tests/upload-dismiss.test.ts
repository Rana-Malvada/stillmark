import { afterEach, expect, it, vi } from 'vitest'
import { uploadDismissDestination } from '@/lib/upload/upload-dismiss'

afterEach(() => vi.unstubAllGlobals())
it('opens an existing accessible album using a fresh bounded check', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  expect(await uploadDismissDestination(745)).toBe('/events/745')
  expect(fetcher).toHaveBeenCalledWith(
    '/api/events/745',
    expect.objectContaining({
      method: 'HEAD',
      cache: 'no-store',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    }),
  )
})
it.each([401, 403, 404, 500])('does not navigate after HTTP %s', async (status) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })))
  expect(await uploadDismissDestination(745)).toBeNull()
})
it('closes without navigation when the check fails or times out', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Timed out', 'TimeoutError')))
  expect(await uploadDismissDestination(745)).toBeNull()
})
it('does not request an absent or invalid album', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  for (const id of [undefined, 0, -1, NaN]) expect(await uploadDismissDestination(id)).toBeNull()
  expect(fetcher).not.toHaveBeenCalled()
})
