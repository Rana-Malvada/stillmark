import { expect, it } from 'vitest'
import { isPlaceLookup, isTravelOverview, isTravelViewport } from '@/lib/travel/travel-response'

const stop = {
  eventId: 7,
  photoId: 8,
  album: 'Trip',
  year: null,
  lat: null,
  lng: null,
  country: '',
  city: '',
  count: 1,
  thumbnail: null,
}
it('accepts unavailable locations and validated empty map results', () => {
  expect(isTravelOverview({ stops: [stop] })).toBe(true)
  expect(isTravelOverview({ stops: [] })).toBe(true)
  expect(isTravelViewport({ clusters: [] })).toBe(true)
  expect(isPlaceLookup({ name: null, cached: false })).toBe(true)
  expect(isPlaceLookup({ name: { label: null }, cached: true })).toBe(true)
})
it('rejects shapes that would crash aggregation, map rendering or React text', () => {
  for (const value of [
    null,
    {},
    { stops: null },
    { stops: [null] },
    { stops: [{ ...stop, count: '1' }] },
    { stops: [{ ...stop, placeName: {} }] },
  ])
    expect(isTravelOverview(value)).toBe(false)
  for (const value of [{}, { clusters: null }, { clusters: [{}] }])
    expect(isTravelViewport(value)).toBe(false)
  expect(isPlaceLookup({ name: { label: {} }, cached: true })).toBe(false)
})
it('rejects invalid geographic values before passing them to Leaflet', () => {
  const cluster = { id: '1', areaId: '1,2', label: 'Place', lat: 1, lng: 2, points: 1, count: 10 }
  expect(isTravelViewport({ clusters: [cluster] })).toBe(true)
  for (const lat of [NaN, Infinity, 91, '1']) {
    expect(isTravelViewport({ clusters: [{ ...cluster, lat }] })).toBe(false)
    expect(isTravelOverview({ stops: [{ ...stop, lat }] })).toBe(false)
  }
})
