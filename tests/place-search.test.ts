import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ one: vi.fn(), query: vi.fn(), lock: vi.fn(), fetch: vi.fn() }))
vi.mock('@/lib/postgres', () => ({ pgQueryOne: m.one, pgQuery: m.query, withAdvisoryLock: m.lock }))
import { searchPlaces } from '@/lib/travel/place-search'

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', m.fetch)
  m.lock.mockImplementation(async (_key, fn) => fn())
})
it('returns cached places without contacting the provider', async () => {
  m.one.mockResolvedValue({ results: [{ label: 'Town', lat: 1, lng: 2 }] })
  expect(await searchPlaces('Town')).toHaveLength(1)
  expect(m.fetch).not.toHaveBeenCalled()
})
it('honors the shared cooldown and disabled lookups', async () => {
  m.one.mockResolvedValueOnce(null).mockResolvedValueOnce({ enabled: false })
  await expect(searchPlaces('Town')).rejects.toMatchObject({ status: 503 })
  m.one
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({
      enabled: true,
      search_endpoint: 'https://nominatim.openstreetmap.org/search',
    })
    .mockResolvedValueOnce(null)
  await expect(searchPlaces('Town')).rejects.toMatchObject({ status: 429 })
  expect(m.fetch).not.toHaveBeenCalled()
})
it('parses and caches only valid results and uses an identifying request with a timeout', async () => {
  m.one
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({
      enabled: true,
      search_endpoint: 'https://nominatim.openstreetmap.org/search',
    })
    .mockResolvedValueOnce({ id: 1 })
  m.fetch.mockResolvedValue(
    Response.json([
      {
        display_name: 'San José, Costa Rica',
        lat: '9.93',
        lon: '-84.08',
        address: { city: 'San José', country: 'Costa Rica' },
      },
      { display_name: 'Bad', lat: '1000', lon: '0' },
    ]),
  )
  expect(await searchPlaces('San José')).toEqual([
    {
      label: 'San José, Costa Rica',
      lat: 9.93,
      lng: -84.08,
      city: 'San José',
      region: null,
      country: 'Costa Rica',
    },
  ])
  const [url, options] = m.fetch.mock.calls[0]
  expect(url.searchParams.get('q')).toBe('san josé')
  expect(options.headers['User-Agent']).toContain('PersonalPhotos')
  expect(options.signal).toBeDefined()
  expect(m.query).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO travel_search_cache'),
    expect.any(Array),
  )
})
it('backs off on rate limits without caching an error as an empty result', async () => {
  m.one
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({
      enabled: true,
      search_endpoint: 'https://nominatim.openstreetmap.org/search',
    })
    .mockResolvedValueOnce({ id: 1 })
  m.fetch.mockResolvedValue(new Response(null, { status: 429 }))
  await expect(searchPlaces('Town')).rejects.toMatchObject({ status: 502 })
  expect(m.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("interval '1 hour'"))
})
