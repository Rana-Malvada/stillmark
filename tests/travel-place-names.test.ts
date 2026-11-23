import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  one: vi.fn(),
  query: vi.fn(),
  lock: vi.fn(),
  auth: vi.fn(),
  origin: vi.fn(),
  stops: vi.fn(),
}))
vi.mock('@/lib/postgres', () => ({ pgQueryOne: m.one, pgQuery: m.query, withAdvisoryLock: m.lock }))
vi.mock('@/lib/identity/auth', () => ({ requireAuth: m.auth, requireSameOrigin: m.origin }))
vi.mock('@/lib/travel/travels', () => ({ travelStops: m.stops }))
import { addPlaceNames, lookupPlaceName, parsePlaceName } from '@/lib/travel/travel-place-names'
import { POST } from '@/app/api/travels/place-name/route'
import { HttpError } from '@/lib/http'

const name = {
  area_id: '40,-75',
  label: 'Philadelphia, Pennsylvania, United States',
  city: 'Philadelphia',
  region: 'Pennsylvania',
  country: 'United States',
}
beforeEach(() => {
  vi.resetAllMocks()
  m.lock.mockImplementation((_key, fn) => fn())
  m.query.mockResolvedValue([])
  m.one.mockResolvedValue(null)
  vi.stubGlobal('fetch', vi.fn())
})
it('extracts readable locality names without storing addresses or display-name payloads', () => {
  expect(
    parsePlaceName({
      address: {
        city: 'Philadelphia',
        state: 'Pennsylvania',
        country: 'United States',
        house_number: '123',
        road: 'Private street',
      },
    }),
  ).toEqual({ ...name, area_id: undefined })
  expect(
    parsePlaceName({ address: { town: 'Town', state: 'Town', country: 'Country' } })?.label,
  ).toBe('Town, Country')
  expect(parsePlaceName({ address: { country: 'Country' } })?.label).toBe('Country')
  expect(parsePlaceName({ error: 'Not found' })).toBeNull()
})
it('returns cached successes and negative results without calling the provider', async () => {
  m.one
    .mockResolvedValueOnce(name)
    .mockResolvedValueOnce({ area_id: '40,-75', label: null, fresh: true })
  expect((await lookupPlaceName(40, -75)).name).toEqual(name)
  expect((await lookupPlaceName(40, -75)).cached).toBe(true)
  expect(fetch).not.toHaveBeenCalled()
})
it('serializes all users and respects the durable cooldown', async () => {
  m.lock.mockResolvedValueOnce(null)
  await expect(lookupPlaceName(40, -75)).rejects.toMatchObject({ status: 429 })
  m.one
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({
      enabled: true,
      endpoint: 'https://nominatim.openstreetmap.org/reverse',
    })
    .mockResolvedValueOnce(null)
  await expect(lookupPlaceName(40, -75)).rejects.toMatchObject({ status: 429 })
  expect(fetch).not.toHaveBeenCalled()
})
it('queries only area coordinates, caches names, and identifies the application', async () => {
  m.one
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({
      enabled: true,
      endpoint: 'https://nominatim.openstreetmap.org/reverse',
    })
    .mockResolvedValueOnce({ id: 1 })
    .mockResolvedValueOnce(name)
  vi.mocked(fetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        address: { city: 'Philadelphia', state: 'Pennsylvania', country: 'United States' },
      }),
    ),
  )
  expect((await lookupPlaceName(40, -75)).name).toEqual(name)
  const [url, options] = vi.mocked(fetch).mock.calls[0]
  expect(String(url)).toContain('lat=40&lon=-75')
  expect(options?.redirect).toBe('error')
  expect(options?.headers).toMatchObject({
    'User-Agent': expect.stringContaining('photos.stillmark.example'),
  })
  expect(m.one.mock.calls.some((c) => c[0].includes("interval '2 seconds'"))).toBe(true)
})
it('backs off globally without misclassifying provider failures as nameless areas', async () => {
  m.one
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({
      enabled: true,
      endpoint: 'https://nominatim.openstreetmap.org/reverse',
    })
    .mockResolvedValueOnce({ id: 1 })
  vi.mocked(fetch).mockResolvedValue(new Response('', { status: 429 }))
  await expect(lookupPlaceName(40, -75)).rejects.toMatchObject({ status: 429 })
  expect(m.query.mock.calls.some((c) => c[0].includes('UPDATE travel_lookup_settings'))).toBe(true)
  expect(m.query.mock.calls.some((c) => c[0].includes('INSERT INTO travel_place_cache'))).toBe(
    false,
  )
})
it('enriches only requested areas and marks deferred lookups', async () => {
  m.query.mockResolvedValue([
    { ...name, deferred: true },
    { area_id: '0,0', label: null, deferred: true },
  ])
  const stops: any[] = [
    { lat: 40, lng: -75, city: '' },
    { lat: 0, lng: 0, city: '' },
    { lat: null, lng: null, city: '' },
  ]
  expect(await addPlaceNames(stops)).toEqual([
    { ...stops[0], placeName: name.label, placeCountry: name.country, placeLookupDeferred: false },
    { ...stops[1], placeName: undefined, placeCountry: undefined, placeLookupDeferred: true },
    stops[2],
  ])
})
it('blocks unauthorized, cross-origin and inaccessible-coordinate lookup requests', async () => {
  const request = () =>
    new Request('https://app/api/travels/place-name', {
      method: 'POST',
      body: JSON.stringify({ area: '40,-75' }),
    })
  m.auth.mockRejectedValueOnce(new HttpError(401, 'No session'))
  expect((await POST(request())).status).toBe(401)
  m.origin.mockRejectedValueOnce(new HttpError(403, 'Wrong origin'))
  expect((await POST(request())).status).toBe(403)
  m.stops.mockResolvedValue([])
  expect((await POST(request())).status).toBe(404)
  expect(fetch).not.toHaveBeenCalled()
  expect(m.lock).not.toHaveBeenCalled()
})

it('keeps synchronous place-name cache reads within the map request lifetime', async () => {
  const { databaseContext, databaseSignal } = await import('@/lib/database/database-context')
  const controller = new AbortController()
  m.query.mockImplementation(async () => {
    expect(databaseContext.getStore()?.kind).toBe('service')
    expect(databaseSignal()).toBe(controller.signal)
    controller.abort()
    databaseSignal()?.throwIfAborted()
  })
  await expect(
    databaseContext.run({ kind: 'request', signal: controller.signal }, () =>
      addPlaceNames([{ lat: 40, lng: -75 } as import('@/lib/travel/travels').TravelStop]),
    ),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(m.query).toHaveBeenCalledTimes(1)
  expect(fetch).not.toHaveBeenCalled()
})

it('explicit retry bypasses a negative cache but still respects the global cooldown', async () => {
  m.one
    .mockResolvedValueOnce({ area_id: '40,-75', label: null, fresh: true })
    .mockResolvedValueOnce({
      enabled: true,
      endpoint: 'https://nominatim.openstreetmap.org/reverse',
    })
    .mockResolvedValueOnce(null)
  await expect(lookupPlaceName(40, -75, true)).rejects.toMatchObject({ status: 429 })
  expect(fetch).not.toHaveBeenCalled()
})
it('retries a previously nameless area and saves the new name', async () => {
  m.one
    .mockResolvedValueOnce({ area_id: '40,-75', label: null, fresh: true })
    .mockResolvedValueOnce({
      enabled: true,
      endpoint: 'https://nominatim.openstreetmap.org/reverse',
    })
    .mockResolvedValueOnce({ id: 1 })
    .mockResolvedValueOnce(name)
  vi.mocked(fetch).mockResolvedValue(
    Response.json({ address: { city: name.city, state: name.region, country: name.country } }),
  )
  expect(await lookupPlaceName(40, -75, true)).toEqual({ name, cached: false })
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('does not spend another provider request for an already named area on explicit retry', async () => {
  m.one.mockResolvedValueOnce(name)
  expect(await lookupPlaceName(40, -75, true)).toEqual({ name, cached: true })
  expect(fetch).not.toHaveBeenCalled()
})
it('a temporary network failure does not poison the place-name cache', async () => {
  m.one
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({
      enabled: true,
      endpoint: 'https://nominatim.openstreetmap.org/reverse',
    })
    .mockResolvedValueOnce({ id: 1 })
  vi.mocked(fetch).mockRejectedValue(new TypeError('connection interrupted'))
  await expect(lookupPlaceName(40, -75)).rejects.toMatchObject({ status: 502 })
  expect(
    [...m.one.mock.calls, ...m.query.mock.calls].some((c) =>
      c[0].includes('INSERT INTO travel_place_cache'),
    ),
  ).toBe(false)
})
it('explicit retries cannot request areas outside the current viewer scope', async () => {
  m.stops.mockResolvedValue([])
  const response = await POST(
    new Request('https://app/api/travels/place-name', {
      method: 'POST',
      body: JSON.stringify({ area: '40,-75', retry: true }),
    }),
  )
  expect(response.status).toBe(404)
  expect(fetch).not.toHaveBeenCalled()
})
