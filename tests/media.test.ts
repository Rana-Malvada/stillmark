vi.mock('@/lib/albums/album-access', () => ({
  requireAlbumAccess: vi.fn(),
  requirePhotosAccess: vi.fn(),
}))
vi.mock('@/lib/observability/activity-action', () => ({ trackAction: mocks.track }))
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), pg: vi.fn(), sf: vi.fn(), track: vi.fn() }))
vi.mock('@/lib/identity/auth', () => ({ requireAuth: mocks.auth }))
vi.mock('@/lib/postgres', () => ({
  pgQueryOne: mocks.pg,
  getDatabaseIdentity: async () => ({ username: 'ALICE', mainAdmin: false }),
}))
vi.mock('@/lib/snowflake', () => ({ querySnowflakeStorage: mocks.sf, querySnowflake: mocks.sf }))
import { GET } from '@/app/api/images/route'
import { getPresignedUrl, invalidateMediaUrl, validateStagePath } from '@/lib/media/image-urls'

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', vi.fn())
  invalidateMediaUrl('originals/test.mp4')
})
it('reuses a signed URL without repeated Snowflake calls', async () => {
  mocks.sf.mockResolvedValue([{ URL: 'https://storage.example/file' }])
  await Promise.all([getPresignedUrl('originals/test.mp4'), getPresignedUrl('originals/test.mp4')])
  await getPresignedUrl('originals/test.mp4')
  expect(mocks.sf).toHaveBeenCalledTimes(1)
})
it('does not serve deleted media even with a cached URL', async () => {
  mocks.pg.mockResolvedValue(null)
  const response = await GET(new Request('https://app/api/images?path=originals/test.mp4'))
  expect(response.status).toBe(404)
  expect(fetch).not.toHaveBeenCalled()
})
it('forwards byte ranges and preserves partial-content headers', async () => {
  mocks.pg.mockResolvedValue({ photo_id: 1 })
  mocks.sf.mockResolvedValue([{ URL: 'https://storage.example/file' }])
  vi.mocked(fetch).mockResolvedValue(
    new Response('part', {
      status: 206,
      headers: {
        'content-range': 'bytes 0-3/100',
        'content-length': '4',
        'accept-ranges': 'bytes',
      },
    }),
  )
  const response = await GET(
    new Request('https://app/api/images?path=originals/test.mp4', {
      headers: { range: 'bytes=0-3' },
    }),
  )
  expect(response.status).toBe(206)
  expect(response.headers.get('content-range')).toBe('bytes 0-3/100')
  expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toEqual({ Range: 'bytes=0-3' })
})
it('rejects traversal and unsupported roots', () => {
  for (const path of [
    '../secret',
    'originals/../secret',
    '/originals/a',
    'originals/a\\b',
    'other/a',
  ])
    expect(() => validateStagePath(path)).toThrow()
})
it('uses a safely quoted literal for Snowflake stage URL compilation', async () => {
  mocks.sf.mockResolvedValue([{ URL: 'https://storage.example/file' }])
  await getPresignedUrl("thumbnails/O'Brien/photo.jpg", 3600)
  expect(mocks.sf).toHaveBeenCalledWith(
    "SELECT GET_PRESIGNED_URL(@PERSONAL_MEDIA.RAW.PHOTO_FILES, 'thumbnails/O''Brien/photo.jpg', 3600) AS URL",
  )
})

it('counts explicit original downloads but not video streaming or thumbnails', async () => {
  mocks.pg.mockResolvedValue({
    photo_id: 1,
    original_stage_path: 'originals/test.mp4',
    file_size_bytes: 100,
  })
  mocks.sf.mockResolvedValue([{ URL: 'https://storage.example/file' }])
  vi.mocked(fetch).mockImplementation(async () => new Response('file', { status: 200 }))
  const r = await GET(new Request('https://app/api/images?path=originals/test.mp4&download=1'))
  expect(r.headers.get('content-disposition')).toContain('attachment')
  expect(mocks.track).toHaveBeenCalledWith('download_requested', 'photo:1', {
    files: 1,
    bytes: 100,
    scope: 'original',
  })
  mocks.track.mockClear()
  await GET(new Request('https://app/api/images?path=originals/test.mp4'))
  expect(mocks.track).not.toHaveBeenCalled()
  await GET(new Request('https://app/api/images?path=thumbnails/test.jpg&download=1'))
  expect(mocks.track).not.toHaveBeenCalled()
})

it('ordinary callers cannot request the private gateway storage handoff', async () => {
  mocks.pg.mockResolvedValue({ photo_id: 1 })
  mocks.sf.mockResolvedValue([{ URL: 'https://storage.example/file' }])
  vi.mocked(fetch).mockResolvedValue(new Response('bytes'))
  const r = await GET(
    new Request('https://app/api/images?path=originals/test.mp4', {
      headers: { 'x-photo-media-transfer': 'edge-v1', 'sf-context-current-user': 'GALLERYOWNER' },
    }),
  )
  expect(r.headers.get('x-photo-media-transfer')).toBe(null)
  expect(await r.text()).toBe('bytes')
})
it('denies a revoked gateway session before issuing any storage URL', async () => {
  mocks.auth.mockRejectedValue(new Error('Logged out'))
  const r = await GET(
    new Request('https://app/api/images?path=originals/test.mp4', {
      headers: {
        'x-photo-media-transfer': 'edge-v1',
        'sf-context-current-user': 'PERSONAL_PHOTOS_GATEWAY',
        'x-photo-gateway-identity': 'revoked',
      },
    }),
  )
  expect(r.status).toBeGreaterThanOrEqual(400)
  expect(mocks.sf).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('returns only an authorized catalog path to the gateway, without fetching media', async () => {
  mocks.pg.mockResolvedValue({ photo_id: 1, event_id: 2 })
  const r = await GET(
    new Request('https://app/api/images?path=originals/test.mp4', {
      headers: {
        'x-photo-media-transfer': 'public-sql-v2',
        'sf-context-current-user': 'PERSONAL_PHOTOS_GATEWAY',
      },
    }),
  )
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual({ path: 'originals/test.mp4', type: 'video/mp4' })
  expect(mocks.auth).toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  expect(mocks.sf).not.toHaveBeenCalled()
})

it('signs new prepared videos from derived storage and preserves legacy paths', async () => {
  mocks.sf.mockResolvedValue([{ URL: 'https://storage.example/file' }])
  await getPresignedUrl('display/prepared/new/720/playback.mp4')
  expect(mocks.sf.mock.calls[0][0]).toContain('@PERSONAL_MEDIA.RAW.DERIVED_FILES')
  await getPresignedUrl('display/video/old/720/playback.mp4')
  expect(mocks.sf.mock.calls[1][0]).toContain('@PERSONAL_MEDIA.RAW.PHOTO_FILES')
})

it('revalidates catalog thumbnails after authorization and returns a bodyless 304', async () => {
  mocks.pg.mockResolvedValue({ photo_id: 1, thumbnail_stage_path: 'thumbnails/cache.jpg' })
  mocks.sf.mockResolvedValue([{ URL: 'https://storage.example/file' }])
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 304, headers: { etag: '"v1"' } }))
  const request = new Request('https://app/api/images?path=thumbnails/cache.jpg', {
    headers: { 'if-none-match': '"v1"' },
  })
  const response = await GET(request)
  expect(response.status).toBe(304)
  expect(response.body).toBeNull()
  expect(response.headers.get('cache-control')).toContain('private, no-cache')
  expect(response.headers.get('etag')).toBe('"v1"')
  expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toEqual({ 'If-None-Match': '"v1"' })
  mocks.pg.mockResolvedValue(null)
  vi.mocked(fetch).mockClear()
  expect((await GET(request)).status).toBe(404)
  expect(fetch).not.toHaveBeenCalled()
})

it('only authorizes thumbnail revalidation for the catalog thumbnail, not downloads or ranges', async () => {
  mocks.pg.mockResolvedValue({ photo_id: 1, thumbnail_stage_path: 'thumbnails/cache.jpg' })
  mocks.sf.mockResolvedValue([{ URL: 'https://storage.example/file' }])
  vi.mocked(fetch).mockImplementation(
    async () => new Response('data', { headers: { etag: '"new"' } }),
  )
  for (const [path, extra] of [
    ['thumbnails/other.jpg', {}],
    ['thumbnails/cache.jpg&download=1', {}],
    ['thumbnails/cache.jpg', { range: 'bytes=0-3' }],
    ['originals/test.mp4', {}],
  ] as [string, Record<string, string>][]) {
    const r = await GET(
      new Request('https://app/api/images?path=' + path, {
        headers: { 'if-none-match': '"old"', ...extra },
      }),
    )
    expect(r.headers.get('cache-control')).toContain('no-store')
    expect(new Headers(vi.mocked(fetch).mock.lastCall?.[1]?.headers).has('if-none-match')).toBe(
      false,
    )
  }
})

it('passes thumbnail caching eligibility only in an authorized gateway grant', async () => {
  mocks.pg.mockResolvedValue({ photo_id: 1, thumbnail_stage_path: 'thumbnails/cache.jpg' })
  const r = await GET(
    new Request('https://app/api/images?path=thumbnails/cache.jpg', {
      headers: {
        'x-photo-media-transfer': 'public-sql-v2',
        'sf-context-current-user': 'PERSONAL_PHOTOS_GATEWAY',
      },
    }),
  )
  expect(await r.json()).toEqual({
    path: 'thumbnails/cache.jpg',
    type: 'image/jpeg',
    revalidateThumbnail: true,
  })
  expect(r.headers.get('cache-control')).toContain('no-store')
  expect(fetch).not.toHaveBeenCalled()
})
