import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ assertion: vi.fn(), secret: vi.fn(() => 'ab'.repeat(32)) }))
vi.mock('@/lib/identity/gateway-auth', () => ({ gatewayAssertion: state.assertion }))
vi.mock('@/lib/snowflake', () => ({
  getSecret: state.secret,
  SecretType: { GENERIC_STRING: 'GENERIC_STRING' },
}))
vi.mock('@/lib/media/image-urls', () => ({
  getImageProxyUrl: (path: string) => '/api/images?' + new URLSearchParams({ path }),
}))
import { thumbnailGrantUrls } from '@/lib/media/thumbnail-grant-urls'
import { verifyThumbnailGrant } from '@/lib/media-grant.mjs'

const path = 'thumbnails/400/1/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/image.jpg'
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})
it('off and native sessions do not request grant secrets', async () => {
  const req = new Request('https://app/api/events?paged=true')
  expect((await thumbnailGrantUrls(req, [path, null]))[1]).toBeNull()
  expect(state.assertion).not.toHaveBeenCalled()
  vi.stubEnv('MEDIA_GRANTS_ENABLED', 'true')
  state.assertion.mockReturnValue(null)
  expect((await thumbnailGrantUrls(req, [path]))[0]).not.toContain('grant=')
  expect(state.secret).not.toHaveBeenCalled()
})
it('issues only eligible thumbnails bound to the verified page session', async () => {
  vi.stubEnv('MEDIA_GRANTS_ENABLED', 'true')
  state.assertion.mockReturnValue({ sid: 'session', sub: 'alice', aud: 'https://app' })
  const urls = await thumbnailGrantUrls(new Request('https://app/api/events?paged=true'), [
    path,
    'originals/private.jpg',
    null,
  ])
  const token = new URL(urls[0]!, 'https://app').searchParams.get('grant')!
  expect(
    await verifyThumbnailGrant(
      token,
      path,
      { sid: 'session', auth0Subject: 'alice' },
      'https://app',
      'ab'.repeat(32),
    ),
  ).toMatchObject({ path })
  expect(urls[1]).not.toContain('grant=')
  expect(urls[2]).toBeNull()
  expect(state.secret).toHaveBeenCalledTimes(1)
})
it('batch delivery does not mint reusable thumbnail grants', async () => {
  vi.stubEnv('MEDIA_GRANTS_ENABLED', 'true')
  vi.stubEnv('PREVIEW_BATCH_ENABLED', 'true')
  const urls = await thumbnailGrantUrls(new Request('https://app/api/events'), [path])
  expect(urls[0]).not.toContain('grant=')
  expect(state.assertion).not.toHaveBeenCalled()
  expect(state.secret).not.toHaveBeenCalled()
})
