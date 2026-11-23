import type { TravelPlace } from './travel-overview'

export interface TravelCluster {
  id: string
  lat: number
  lng: number
  count: number
  points: number
  areaId: string
  label: string
}
export const TRAVEL_MAX_ZOOM = 19
/** Keep nearby positions grouped even at the closest supported zoom. */
export function travelClusters(places: TravelPlace[], zoom: number): TravelCluster[] {
  const exact = new Map<string, TravelCluster>()
  for (const area of places)
    for (const stop of area.stops) {
      const lat = stop.gpsLat ?? stop.lat
      const lng = stop.gpsLng ?? stop.lng
      if (
        lat == null ||
        lng == null ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        Math.abs(lat) > 90 ||
        Math.abs(lng) > 180
      )
        continue
      const id = `${lat},${lng}`
      const found = exact.get(id)
      if (found) found.count += stop.count
      else
        exact.set(id, {
          id,
          lat,
          lng,
          count: stop.count,
          points: 1,
          areaId: area.id,
          label: area.label,
        })
    }
  const cells = new Map<string, TravelCluster>()
  const scale = 256 * 2 ** Math.min(TRAVEL_MAX_ZOOM, Math.max(0, Math.floor(zoom)))
  for (const point of exact.values()) {
    const sin = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, point.lat)) * Math.PI) / 180)
    const x = ((point.lng + 180) / 360) * scale
    const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale
    const key = `${Math.floor(x / 60)}:${Math.floor(y / 60)}`
    const found = cells.get(key)
    if (found) {
      const count = found.count + point.count
      found.lat = (found.lat * found.count + point.lat * point.count) / count
      found.lng = (found.lng * found.count + point.lng * point.count) / count
      found.count = count
      found.points++
      found.id = key
    } else cells.set(key, { ...point })
  }
  return [...cells.values()]
}
