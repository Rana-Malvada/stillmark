import type { TravelStop } from './travels'

export type TravelYear = 'all' | 'undated' | string
export interface TravelPlace {
  id: string
  label: string
  lat: number
  lng: number
  count: number
  stops: TravelStop[]
}
export function travelOverview(stops: TravelStop[], year: TravelYear = 'all') {
  const filtered = stops.filter(
    (s) => year === 'all' || (year === 'undated' ? s.year === null : String(s.year) === year),
  )
  const places = new Map<string, TravelPlace>()
  for (const stop of filtered) {
    if (
      stop.lat === null ||
      stop.lng === null ||
      !Number.isFinite(stop.lat) ||
      !Number.isFinite(stop.lng)
    )
      continue
    const id = `${stop.lat},${stop.lng}`
    const label = stop.city
      ? [stop.city, stop.country].filter(Boolean).join(', ')
      : stop.placeName ||
        stop.country ||
        `Area near ${stop.lat.toFixed(1)}°, ${stop.lng.toFixed(1)}°`
    let place = places.get(id)
    if (!place) {
      place = { id, label, lat: stop.lat, lng: stop.lng, count: 0, stops: [] }
      places.set(id, place)
    }
    if (!place.stops.some((s) => s.city) && stop.city)
      place.label = [stop.city, stop.country].filter(Boolean).join(', ')
    place.count += stop.count
    place.stops.push(stop)
  }
  const located = [...places.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
  return {
    places: located,
    namedPlaces: located.filter((p) => p.stops.some((s) => s.city || s.placeName)).length,
    unnamedPlaces: located.filter((p) => p.stops.every((s) => !s.city && !s.placeName)),
    lookupPlaces: located.filter((p) =>
      p.stops.every((s) => !s.city && !s.placeName && !s.placeLookupDeferred),
    ),
    total: filtered.reduce((n, s) => n + s.count, 0),
    mapped: located.reduce((n, p) => n + p.count, 0),
    albums: new Set(filtered.map((s) => s.eventId)).size,
    countries: new Set(
      filtered
        .filter((s) => s.lat !== null && s.lng !== null && (s.country || s.placeCountry))
        .map((s) => (s.country || s.placeCountry!).toLocaleLowerCase()),
    ).size,
    years: [...new Set(stops.flatMap((s) => (s.year === null ? [] : [s.year])))].sort(
      (a, b) => b - a,
    ),
    undated: stops.some((s) => s.year === null),
  }
}
