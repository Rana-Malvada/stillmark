import { beforeEach, expect, it, vi } from 'vitest'
import sharp from 'sharp'

const mocks = vi.hoisted(() => ({ album: vi.fn(), query: vi.fn(), url: vi.fn(), fetch: vi.fn() }))
vi.mock('@/lib/albums/public-albums', () => ({
  publicAlbum: mocks.album,
  shareHeaders: { 'Cache-Control': 'private, no-store' },
}))
vi.mock('@/lib/postgres', () => ({ pgQueryOne: mocks.query }))
vi.mock('@/lib/media/image-urls', () => ({
  getPresignedUrl: mocks.url,
  invalidateMediaUrl: vi.fn(),
}))
vi.mock('@/lib/media/media-fetch', () => ({ fetchMedia: mocks.fetch }))
import { sharedLinkMetadata, sharedLinkPreview } from '@/lib/albums/shared-link-preview'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.album.mockResolvedValue({ event_id: 7, photo_ids: [42] })
  mocks.query.mockResolvedValue(null)
})
it('escapes titles and uses canonical capability-scoped image URLs', () => {
  const tags = sharedLinkMetadata('a'.repeat(43), 'Trip " <script>')
  expect(tags).toContain('Trip &quot; &lt;script&gt;')
  expect(tags).toContain('?asset=og-image&amp;v=1')
  expect(tags).toContain('summary_large_image')
})
it('renders a branded JPEG for empty albums without fetching media', async () => {
  const response = await sharedLinkPreview('token', new AbortController().signal)
  expect(response.headers.get('Cache-Control')).toContain('no-store')
  const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata()
  expect(meta).toMatchObject({ width: 1200, height: 630, format: 'jpeg' })
  expect(mocks.fetch).not.toHaveBeenCalled()
  expect(mocks.query.mock.calls[0][1]).toEqual([7, [42]])
  expect(mocks.query.mock.calls[0][0]).toContain('p.photo_id=ANY($2::integer[])')
})
it('uses only a derived thumbnail and strips embedded metadata', async () => {
  mocks.query.mockResolvedValue({ thumbnail_stage_path: 'thumb.jpg' })
  mocks.url.mockResolvedValue('https://storage.example/thumb')
  const input = await sharp({
    create: { width: 300, height: 200, channels: 3, background: '#aabbee' },
  })
    .jpeg()
    .toBuffer()
  mocks.fetch.mockResolvedValue(new Response(new Uint8Array(input)))
  const response = await sharedLinkPreview('token', new AbortController().signal)
  const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata()
  expect(meta.exif).toBeUndefined()
  expect(mocks.url).toHaveBeenCalledWith('thumb.jpg')
  expect(mocks.album).toHaveBeenCalledTimes(2)
})
it('denies expired links before fetching and revoked links before returning pixels', async () => {
  mocks.album.mockRejectedValueOnce(new Error('expired'))
  await expect(sharedLinkPreview('token', new AbortController().signal)).rejects.toThrow('expired')
  expect(mocks.query).not.toHaveBeenCalled()
  mocks.album
    .mockResolvedValueOnce({ event_id: 7, photo_ids: null })
    .mockRejectedValueOnce(new Error('revoked'))
  await expect(sharedLinkPreview('token', new AbortController().signal)).rejects.toThrow('revoked')
})
