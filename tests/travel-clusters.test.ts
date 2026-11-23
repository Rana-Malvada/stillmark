import { expect, it } from 'vitest'
import { travelClusters } from '@/lib/travel/travel-clusters'
import type { TravelPlace } from '@/lib/travel/travel-overview'

const places = [
  {
    id: '40,-74',
    label: 'Place',
    lat: 40,
    lng: -74,
    count: 6,
    stops: [
      { lat: 40, lng: -74, gpsLat: 40.001, gpsLng: -74.001, count: 2 },
      { lat: 40, lng: -74, gpsLat: 40.001, gpsLng: -74.001, count: 1 },
      { lat: 40, lng: -74, gpsLat: 40.002, gpsLng: -74.002, count: 3 },
    ],
  },
] as TravelPlace[]
it('allows street detail while grouping nearly identical positions', () => {
  expect(travelClusters(places, 2)).toHaveLength(1)
  expect(travelClusters(places, 2)[0].count).toBe(6)
  expect(travelClusters(places, 19)).toHaveLength(2)
  expect(travelClusters(places, 25)).toEqual(travelClusters(places, 19))
  const close = [
    {
      ...places[0],
      stops: [
        { ...places[0].stops[0], gpsLat: 40.001001, count: 2 },
        { ...places[0].stops[0], gpsLat: 40.001002, count: 3 },
      ],
    },
  ]
  expect(travelClusters(close, 19)).toHaveLength(1)
  expect(travelClusters(close, 19)[0].count).toBe(5)
})
it('preserves counts at every zoom', () => {
  for (let z = 0; z <= 19; z++)
    expect(travelClusters(places, z).reduce((n, p) => n + p.count, 0)).toBe(6)
})
