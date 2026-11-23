import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  album: vi.fn(),
  one: vi.fn(),
  playback: vi.fn(),
  handoff: vi.fn(),
  url: vi.fn(),
  fetch: vi.fn(),
}))
vi.mock('@/lib/albums/public-albums', () => ({
  tokenHash: () => 'a'.repeat(64),
  publicAlbum: m.album,
  shareHeaders: { 'Cache-Control': 'no-store' },
}))
vi.mock('@/lib/postgres', () => ({ pgQueryOne: m.one }))
vi.mock('@/lib/video/video-playback', () => ({ getVideoPlayback: m.playback }))
vi.mock('@/lib/media/media-handoff', () => ({ mediaHandoff: m.handoff }))
vi.mock('@/lib/media/image-urls', () => ({ getPresignedUrl: m.url, invalidateMediaUrl: vi.fn() }))
vi.mock('@/lib/media/media-fetch', () => ({ fetchMedia: m.fetch }))
import { GET } from '@/app/share/[token]/media/[photoId]/route'

const context = { params: Promise.resolve({ token: 'A'.repeat(43), photoId: '10' }) }
const call = (kind: string) =>
  GET(
    new Request(
      'https://photos.stillmark.example/share/' + 'A'.repeat(43) + '/media/10?kind=' + kind,
    ),
    context,
  )
beforeEach(() => {
  vi.resetAllMocks()
  m.album.mockResolvedValue({ event_id: 1, allow_downloads: false })
  m.one.mockResolvedValue({
    media_type: 'video',
    original_stage_path: 'originals/a.mp4',
    display_stage_path: 'originals/a.mp4',
    thumbnail_stage_path: 'thumbnails/a.jpg',
  })
  m.playback.mockResolvedValue(null)
  m.url.mockResolvedValue('https://storage.example/media')
  m.fetch.mockResolvedValue(new Response('media'))
  m.handoff.mockReturnValue(null)
})
it('blocks original bytes through display alias without a prepared copy', async () => {
  expect((await call('display')).status).toBe(403)
  expect(m.url).not.toHaveBeenCalled()
  expect(m.handoff).not.toHaveBeenCalled()
})
it('allows a prepared preview without original download permission', async () => {
  m.playback.mockResolvedValue({ stage_path: 'display/video/a/720/playback.mp4', renditions: [] })
  expect((await call('display')).status).toBe(200)
  expect(m.url).toHaveBeenCalledWith('display/video/a/720/playback.mp4')
})
it('blocks explicit original download', async () => {
  expect((await call('original')).status).toBe(403)
  expect(m.fetch).not.toHaveBeenCalled()
})
it('allows original fallback when the owner permits downloads', async () => {
  m.album.mockResolvedValue({ event_id: 1, allow_downloads: true })
  expect((await call('display')).status).toBe(200)
  expect(m.url).toHaveBeenCalledWith('originals/a.mp4')
})
it('rejects a photo outside the shared album before storage access', async () => {
  m.one.mockResolvedValue(null)
  expect((await call('display')).status).toBe(404)
  expect(m.one.mock.calls[0][1]).toEqual([10, 1, null])
  // A selected-photo link passes its selection to the same lookup.
  m.album.mockResolvedValue({ event_id: 1, allow_downloads: false, photo_ids: [11, 12] })
  expect((await call('display')).status).toBe(404)
  expect(m.one.mock.calls[1][0]).toContain('photo_id=ANY($3::integer[])')
  expect(m.one.mock.calls[1][1]).toEqual([10, 1, [11, 12]])
  expect(m.url).not.toHaveBeenCalled()
})
