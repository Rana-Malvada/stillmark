import { deployment } from '../../config/deployment.mjs'
import { databaseSignal, withServiceDatabase } from '../database/database-context'
import { pgQuery, pgQueryOne, withAdvisoryLock } from '@/lib/postgres'
import { HttpError } from '@/lib/http'
import type { TravelStop } from '@/lib/travel/travels'

export interface PlaceName {
  area_id: string
  label: string | null
  city: string | null
  region: string | null
  country: string | null
}
export const areaId = (lat: number, lng: number) => `${lat},${lng}`
async function addPlaceNamesService(stops: TravelStop[]): Promise<TravelStop[]> {
  const ids = [
    ...new Set(
      stops.flatMap((s) => (s.lat === null || s.lng === null ? [] : [areaId(s.lat, s.lng)])),
    ),
  ]
  if (!ids.length) return stops
  const names = await pgQuery<PlaceName & { deferred: boolean }>(
    'SELECT area_id,label,city,region,country,retry_after>now() AS deferred FROM travel_place_cache WHERE area_id=ANY($1::text[])',
    [ids],
  )
  const byId = new Map(names.map((n) => [n.area_id, n]))
  return stops.map((s) => {
    const name = s.lat === null || s.lng === null ? undefined : byId.get(areaId(s.lat, s.lng))
    return name
      ? {
          ...s,
          placeLookupDeferred: !name.label && name.deferred,
          placeName: name.label ?? undefined,
          placeCountry: name.country ?? undefined,
        }
      : s
  })
}
function text(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 200) : ''
}
export function parsePlaceName(body: unknown): Omit<PlaceName, 'area_id'> | null {
  if (
    !body ||
    typeof body !== 'object' ||
    !('address' in body) ||
    !body.address ||
    typeof body.address !== 'object'
  )
    return null
  const address = body.address as Record<string, unknown>
  const city =
    text(address.city) ||
    text(address.town) ||
    text(address.village) ||
    text(address.municipality) ||
    text(address.hamlet) ||
    text(address.county)
  const region = text(address.state) || text(address.region)
  const country = text(address.country)
  const label = [...new Set([city, region, country].filter(Boolean))].join(', ')
  return label
    ? { label, city: city || null, region: region || null, country: country || null }
    : null
}
/** User-triggered only. One global lock plus a durable cooldown across all replicas. */
async function lookupPlaceNameService(lat: number, lng: number, retry = false) {
  const id = areaId(lat, lng)
  const result = await withAdvisoryLock('travel-place-lookup', async () => {
    const cached = await pgQueryOne<PlaceName & { fresh: boolean }>(
      'SELECT *,retry_after>now() AS fresh FROM travel_place_cache WHERE area_id=$1',
      [id],
    )
    if (cached?.label || (cached?.fresh && !retry)) return { name: cached, cached: true }
    const settings = await pgQueryOne<{ enabled: boolean; endpoint: string; retrySeconds: number }>(
      `SELECT enabled,endpoint,GREATEST(0,ceil(extract(epoch FROM (next_request_at-now()))))::int AS "retrySeconds" FROM travel_lookup_settings WHERE id=1`,
    )
    if (!settings?.enabled) throw new HttpError(503, 'Place lookup is currently disabled')
    const endpoint = new URL(settings.endpoint)
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password)
      throw new HttpError(503, 'Place lookup is not configured')
    const allowed = await pgQueryOne(
      `UPDATE travel_lookup_settings SET next_request_at=now()+interval '2 seconds' WHERE id=1 AND next_request_at<=now() RETURNING id`,
    )
    if (!allowed)
      throw new HttpError(
        429,
        settings.retrySeconds > 30
          ? `The place-name provider is paused. Try again in ${Math.ceil(settings.retrySeconds / 60)} minutes.`
          : 'Place lookup is busy. Please try again shortly.',
      )
    endpoint.search = new URLSearchParams({
      format: 'jsonv2',
      lat: String(lat),
      lon: String(lng),
      zoom: '10',
      addressdetails: '1',
      'accept-language': 'en',
    }).toString()
    try {
      const response = await fetch(endpoint, {
        headers: {
          'User-Agent': `PersonalPhotos/1.0 (+${deployment.GATEWAY_ORIGIN})`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      })
      if (response.status === 429 || response.status === 403) {
        await pgQuery(
          "UPDATE travel_lookup_settings SET next_request_at=now()+interval '1 hour' WHERE id=1",
        )
        throw new HttpError(
          429,
          'The place-name provider has paused requests. Please retry in one hour.',
        )
      }
      if (!response.ok && response.status !== 404) throw new Error('Provider unavailable')
      const name = response.status === 404 ? null : parsePlaceName(await response.json())
      const row = await pgQueryOne<PlaceName>(
        `INSERT INTO travel_place_cache(area_id,label,city,region,country,retry_after)
    VALUES($1,$2,$3,$4,$5,now()+interval '7 days')
    ON CONFLICT(area_id) DO UPDATE SET label=EXCLUDED.label,city=EXCLUDED.city,region=EXCLUDED.region,
      country=EXCLUDED.country,retry_after=EXCLUDED.retry_after,updated_at=now()
    RETURNING *`,
        [id, name?.label ?? null, name?.city ?? null, name?.region ?? null, name?.country ?? null],
      )
      return { name: row, cached: false }
    } catch (error) {
      if (error instanceof HttpError) throw error
      // A provider failure is not evidence that a place has no name. Preserve
      // any previous successful result and the global provider cooldown.
      throw new HttpError(
        502,
        'Place name unavailable right now. Coordinates are still available; try again later.',
      )
    }
  })
  if (!result) throw new HttpError(429, 'Place lookup is busy. Please try again shortly.')
  return result
}

export function addPlaceNames(...args: Parameters<typeof addPlaceNamesService>) {
  return withServiceDatabase(() => addPlaceNamesService(...args), databaseSignal())
}

export function lookupPlaceName(...args: Parameters<typeof lookupPlaceNameService>) {
  return withServiceDatabase(() => lookupPlaceNameService(...args))
}
