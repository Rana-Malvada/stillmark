import { expect, it } from 'vitest'
import { travelOverview } from '@/lib/travel/travel-overview'
import type { TravelStop } from '@/lib/travel/travels'

const stop: TravelStop = {
  eventId: 1,
  album: 'Trip',
  year: 2025,
  lat: 10.1,
  lng: 20.2,
  country: 'France',
  city: 'Paris',
  count: 3,
  photoId: 1,
  thumbnail: null,
}
it('combines areas across albums and counts only recorded countries on located files', () => {
  const result = travelOverview([
    stop,
    { ...stop, eventId: 2, count: 2, country: 'france' },
    { ...stop, lat: null, lng: null, country: 'Unknown', count: 4 },
  ])
  expect(result).toMatchObject({ total: 9, mapped: 5, albums: 2, countries: 1, years: [2025] })
  expect(result.places).toHaveLength(1)
  expect(result.places[0].count).toBe(5)
})
it('filters capture years while preserving the year selector and unknown-date option', () => {
  const rows = [stop, { ...stop, year: 2024 }, { ...stop, year: null }]
  expect(travelOverview(rows, '2024')).toMatchObject({
    total: 3,
    years: [2025, 2024],
    undated: true,
  })
  expect(travelOverview(rows, 'undated').total).toBe(3)
  expect(travelOverview(rows, '2000').places).toEqual([])
})
it('supports zero coordinates, coordinate fallback labels and empty collections', () => {
  expect(
    travelOverview([{ ...stop, lat: 0, lng: 0, city: '', country: '' }]).places[0],
  ).toMatchObject({ label: 'Area near 0.0°, 0.0°', lat: 0, lng: 0 })
  expect(travelOverview([])).toMatchObject({
    places: [],
    total: 0,
    mapped: 0,
    albums: 0,
    countries: 0,
    years: [],
    undated: false,
  })
})
it('tracks naming progress separately from mapped areas and deferred lookups', () => {
  const unknown = { ...stop, city: '', country: '', lat: 20 }
  const deferred = { ...unknown, lat: 30, placeLookupDeferred: true }
  const before = travelOverview([stop, unknown, deferred, { ...unknown, eventId: 2 }])
  expect(before.places).toHaveLength(3)
  expect(before.namedPlaces).toBe(1)
  expect(before.unnamedPlaces).toHaveLength(2)
  expect(before.lookupPlaces).toHaveLength(1)
  const after = travelOverview([stop, { ...unknown, placeName: 'Saved city' }, deferred])
  expect(after.places).toHaveLength(3)
  expect(after.namedPlaces).toBe(2)
  expect(after.unnamedPlaces).toHaveLength(1)
  expect(after.lookupPlaces).toHaveLength(0)
  expect(travelOverview([stop, unknown], '2020').namedPlaces).toBe(0)
})
