import { afterEach, expect, it, vi } from 'vitest'
import { endGallerySession } from '@/lib/browser-logout'

afterEach(() => vi.unstubAllGlobals())
it('requires confirmed platform logout and does not navigate to its JSON response', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json({ responseType: 'SUCCESS_RESPOND_TO_CUSTOMER' }))
  vi.stubGlobal('fetch', fetch)
  await endGallerySession()
  expect(fetch).toHaveBeenCalledWith(
    '/sfc-endpoint/logout',
    expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' }),
  )
})
it('rejects unconfirmed or failed logout', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: 'failure' }, { status: 500 }))
    .mockResolvedValueOnce(Response.json({ authenticated: true }))
  vi.stubGlobal('fetch', fetch)
  await expect(endGallerySession()).rejects.toThrow()
  await expect(endGallerySession()).rejects.toThrow()
})
