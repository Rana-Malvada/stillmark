import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  caller: vi.fn(),
  one: vi.fn(),
  sign: vi.fn(),
  media: vi.fn(),
  invalidate: vi.fn(),
}))
vi.mock('@/lib/albums/album-access', () => ({ albumCaller: mocks.caller }))
vi.mock('@/lib/postgres', () => ({ pgQueryOne: mocks.one }))
vi.mock('@/lib/media/image-urls', () => ({
  getPresignedUrl: mocks.sign,
  invalidateMediaUrl: mocks.invalidate,
  validateStagePath: (s: string) => s,
}))
vi.mock('@/lib/media/media-fetch', () => ({ fetchMedia: mocks.media }))
import { GET } from '@/app/api/trash/[photoId]/thumbnail/route'

const request = () =>
  GET(new Request('https://photos.test/api/trash/7/thumbnail'), {
    params: Promise.resolve({ photoId: '7' }),
  })
beforeEach(() => {
  vi.resetAllMocks()
  mocks.caller.mockResolvedValue({ mainAdmin: false, username: 'alice' })
  mocks.sign.mockResolvedValue('https://storage.test/signed')
})
it('checks current ownership and expiry before signing or reading storage', async () => {
  mocks.one.mockResolvedValue(null)
  expect((await request()).status).toBe(404)
  expect(mocks.one.mock.calls[0][0]).toContain('expires_at>NOW()')
  expect(mocks.one.mock.calls[0][0]).toContain('owner_username=$3')
  expect(mocks.one.mock.calls[0][1]).toEqual([7, false, 'alice'])
  expect(mocks.sign).not.toHaveBeenCalled()
  expect(mocks.media).not.toHaveBeenCalled()
})
it('streams only a private thumbnail and retries an expired signed URL once', async () => {
  mocks.one.mockResolvedValue({ path: 'thumb/7.jpg' })
  mocks.media
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(new Response('image'))
  const response = await request()
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe('image/jpeg')
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(mocks.invalidate).toHaveBeenCalledWith('thumb/7.jpg')
  expect(mocks.sign).toHaveBeenCalledTimes(2)
})
it('does not expose video or arbitrary stored content as an image', async () => {
  mocks.one.mockResolvedValue({ path: 'original/7.mov' })
  expect((await request()).status).toBe(404)
  expect(mocks.sign).not.toHaveBeenCalled()
})
