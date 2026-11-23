import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { HttpError } from '@/lib/http'

const mocks = vi.hoisted(() => ({
  album: vi.fn(),
  query: vi.fn(),
  url: vi.fn(),
  invalidate: vi.fn(),
}))
vi.mock('@/lib/albums/public-albums', async (original) => ({
  ...(await original<typeof import('@/lib/albums/public-albums')>()),
  publicAlbum: mocks.album,
}))
vi.mock('@/lib/postgres', () => ({
  pgQuery: mocks.query,
  // The per-file check: the listed row with that ID is still downloadable.
  pgQueryOne: async (_sql: string, [photoId]: [number]) =>
    ((await mocks.query()) as { photo_id: number }[]).find((row) => row.photo_id === photoId),
}))
vi.mock('@/lib/media/image-urls', () => ({
  getPresignedUrl: mocks.url,
  invalidateMediaUrl: mocks.invalidate,
}))
import { GET } from '@/app/share/[token]/download/route'

const token = 'a'.repeat(43)
const request = (value = token) =>
  GET(new Request(`https://app/share/${value}/download`), {
    params: Promise.resolve({ token: value }),
  })
beforeEach(() => {
  vi.resetAllMocks()
  mocks.album.mockResolvedValue({ event_id: 7, event_name: 'Family / Trip', allow_downloads: true })
  mocks.query.mockResolvedValue([
    {
      photo_id: 1,
      source_filename: '../a.jpg',
      original_stage_path: 'originals/a.jpg',
      ingest_status: 'READY',
    },
    {
      photo_id: 2,
      source_filename: 'movie.mov',
      original_stage_path: 'originals/b.mov',
      ingest_status: 'READY',
    },
  ])
  mocks.url.mockImplementation(async (path) => `https://storage/${path}`)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('original bytes')),
  )
})
afterEach(() => vi.unstubAllGlobals())
it('downloads all originals beyond the gallery page, including videos and safe unique names', async () => {
  const rows = await mocks.query()
  mocks.query.mockResolvedValue([
    ...rows,
    ...Array.from({ length: 65 }, (_, i) => ({ ...rows[0], photo_id: i + 3 })),
  ])
  const response = await request()
  expect(response.status).toBe(200)
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="Family-Trip.zip"')
  expect(response.headers.get('cache-control')).toContain('no-store')
  const zip = unzipSync(new Uint8Array(await response.arrayBuffer()))
  expect(Object.keys(zip)).toHaveLength(67)
  expect(strFromU8(zip['2-movie.mov'])).toBe('original bytes')
  expect(Object.keys(zip).every((name) => !name.includes('/'))).toBe(true)
  const [sql, params] = mocks.query.mock.calls.find(([text]) => text)!
  expect(sql).toContain('WHERE event_id=$1')
  expect(sql).not.toMatch(/LIMIT|OFFSET/)
  expect(params).toEqual([7, null])
})
it('denies view-only links before accessing files', async () => {
  mocks.album.mockResolvedValue({ allow_downloads: false })
  expect((await request()).status).toBe(403)
  expect(mocks.query).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})
it('denies invalid, expired, or revoked links', async () => {
  expect((await request('bad')).status).toBe(404)
  expect(mocks.album).not.toHaveBeenCalled()
  mocks.album.mockRejectedValue(new HttpError(404, 'This link is unavailable or has expired.'))
  expect((await request()).status).toBe(404)
  expect(fetch).not.toHaveBeenCalled()
})
it('handles empty and unready albums without silently omitting files', async () => {
  mocks.query.mockResolvedValue([])
  expect((await request()).status).toBe(404)
  mocks.query.mockResolvedValue([{ ingest_status: 'PROCESSING' }])
  expect((await request()).status).toBe(409)
  expect(fetch).not.toHaveBeenCalled()
})
it('rechecks permission before opening the first original', async () => {
  mocks.album
    .mockResolvedValueOnce({ event_id: 7, event_name: 'Trip', allow_downloads: true })
    .mockRejectedValue(new HttpError(404, 'Expired'))
  expect((await request()).status).toBe(404)
  expect(fetch).not.toHaveBeenCalled()
})
it('rechecks permission after fetching the first original', async () => {
  mocks.album
    .mockResolvedValueOnce({ event_id: 7, event_name: 'Trip', allow_downloads: true })
    .mockResolvedValueOnce({ event_id: 7, allow_downloads: true })
    .mockRejectedValue(new HttpError(404, 'Expired'))
  expect((await request()).status).toBe(404)
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('fails the stream if the link is revoked during a download', async () => {
  mocks.album
    .mockResolvedValueOnce({ event_id: 7, event_name: 'Trip', allow_downloads: true })
    .mockResolvedValueOnce({ event_id: 7, allow_downloads: true })
    .mockResolvedValueOnce({ event_id: 7, allow_downloads: true })
    .mockRejectedValue(new HttpError(404, 'Revoked'))
  const response = await request()
  await expect(response.arrayBuffer()).rejects.toThrow()
  // The second original is never requested from storage.
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('retries expired storage URLs and reports unavailable storage', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 403 }))
  const response = await request()
  await response.arrayBuffer()
  expect(mocks.invalidate).toHaveBeenCalledWith('originals/a.jpg')
  vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }))
  expect((await request()).status).toBe(502)
})
