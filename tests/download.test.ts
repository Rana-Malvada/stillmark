vi.mock('@/lib/albums/album-access', () => ({
  requireAlbumAccess: vi.fn(),
  requirePhotosAccess: vi.fn(),
  albumCaller: async () => ({ username: 'ALICE', mainAdmin: false }),
}))
vi.mock('@/lib/observability/activity-action', () => ({ trackAction: mocks.track }))
// No gateway assertion: the request's own identity is used for every file.
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), pg: vi.fn(), url: vi.fn(), track: vi.fn() }))
vi.mock('@/lib/identity/auth', () => ({ requireAuth: mocks.auth }))
vi.mock('@/lib/postgres', () => ({
  pgQuery: mocks.pg,
  // The per-file check: the listed row with that ID is still downloadable.
  pgQueryOne: async (_sql: string, [photoId]: [number]) =>
    ((await mocks.pg()) as { photo_id: number }[]).find((row) => row.photo_id === photoId),
}))
vi.mock('@/lib/media/image-urls', () => ({
  getPresignedUrl: mocks.url,
  invalidateMediaUrl: vi.fn(),
}))
import { GET } from '@/app/api/photos/download/route'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.url.mockResolvedValue('https://example.com/original')
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => new Response('photo bytes')),
  )
})
afterEach(() => vi.unstubAllGlobals())
it('streams a readable ZIP with unique safe filenames and original bytes', async () => {
  mocks.pg.mockResolvedValue([
    { photo_id: 1, source_filename: 'a.jpg', original_stage_path: 'originals/a.jpg' },
    { photo_id: 2, source_filename: 'a.jpg', original_stage_path: 'originals/b.jpg' },
  ])
  const response = await GET(new Request('https://app/api/photos/download?ids=1,2'))
  expect(response.status).toBe(200)
  expect(mocks.track).toHaveBeenCalledWith(
    'download_requested',
    'zip',
    expect.objectContaining({ files: 2, scope: 'zip' }),
  )
  expect(response.headers.get('content-disposition')).toContain('attachment')
  const zip = unzipSync(new Uint8Array(await response.arrayBuffer()))
  expect(Object.keys(zip)).toEqual(['1-a.jpg', '2-a.jpg'])
  expect(strFromU8(zip['1-a.jpg'])).toBe('photo bytes')
})
it('rejects unavailable files before requesting storage', async () => {
  mocks.pg.mockResolvedValue([])
  expect((await GET(new Request('https://app/api/photos/download?ids=1'))).status).toBe(409)
  expect(fetch).not.toHaveBeenCalled()
})
