import type { TravelStop } from './travels'
import type { TravelCluster } from './travel-clusters'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const coordinate = (value: unknown, bound: number) => number(value) && Math.abs(value) <= bound
const optionalString = (value: unknown) => value === undefined || typeof value === 'string'

/** Validate before cached responses enter the map and location aggregations. */
export function isTravelOverview(value: unknown): value is { stops: TravelStop[] } {
  return (
    record(value) &&
    Array.isArray(value.stops) &&
    value.stops.every(
      (stop) =>
        record(stop) &&
        number(stop.eventId) &&
        number(stop.photoId) &&
        typeof stop.album === 'string' &&
        (stop.year === null || number(stop.year)) &&
        (stop.lat === null || coordinate(stop.lat, 90)) &&
        (stop.lng === null || coordinate(stop.lng, 180)) &&
        (stop.gpsLat == null || coordinate(stop.gpsLat, 90)) &&
        (stop.gpsLng == null || coordinate(stop.gpsLng, 180)) &&
        typeof stop.country === 'string' &&
        typeof stop.city === 'string' &&
        number(stop.count) &&
        stop.count >= 0 &&
        (stop.thumbnail === null || typeof stop.thumbnail === 'string') &&
        optionalString(stop.placeName) &&
        optionalString(stop.placeCountry) &&
        (stop.placeLookupDeferred === undefined || typeof stop.placeLookupDeferred === 'boolean'),
    )
  )
}

export function isTravelViewport(value: unknown): value is { clusters: TravelCluster[] } {
  return (
    record(value) &&
    Array.isArray(value.clusters) &&
    value.clusters.every(
      (cluster) =>
        record(cluster) &&
        ['id', 'areaId', 'label'].every((key) => typeof cluster[key] === 'string') &&
        coordinate(cluster.lat, 90) &&
        coordinate(cluster.lng, 180) &&
        number(cluster.count) &&
        cluster.count >= 0 &&
        number(cluster.points) &&
        cluster.points >= 1,
    )
  )
}

export function isPlaceLookup(
  value: unknown,
): value is { name: { label: string | null } | null; cached: boolean } {
  return (
    record(value) &&
    typeof value.cached === 'boolean' &&
    (value.name === null ||
      (record(value.name) && (value.name.label === null || typeof value.name.label === 'string')))
  )
}
