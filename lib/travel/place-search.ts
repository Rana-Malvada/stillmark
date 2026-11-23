import { deployment } from '../../config/deployment.mjs'
import { withServiceDatabase } from '../database/database-context'
import { pgQuery, pgQueryOne, withAdvisoryLock } from '@/lib/postgres'
import { HttpError, textValue } from '@/lib/http'
import { parsePlaceName } from '@/lib/travel/travel-place-names'
import { type AlbumPlace, validatePlace } from '@/lib/albums/album-location'
/** Explicit searches only, cached and sharing the reverse-lookup global cooldown. */
async function searchPlacesService(value: unknown): Promise<AlbumPlace[]> {
  const query = textValue(value, 'place search', 200).toLowerCase()
  const result = await withAdvisoryLock('travel-place-lookup', async () => {
    const cached = await pgQueryOne<{ results: AlbumPlace[] }>(
      "SELECT results FROM travel_search_cache WHERE query=$1 AND updated_at>now()-interval '30 days'",
      [query],
    )
    if (cached) return cached.results
    const settings = await pgQueryOne<{ enabled: boolean; search_endpoint: string }>(
      'SELECT enabled,search_endpoint FROM travel_lookup_settings WHERE id=1',
    )
    if (!settings?.enabled) throw new HttpError(503, 'Place lookup is currently disabled')
    const url = new URL(settings.search_endpoint)
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new HttpError(503, 'Place lookup is not configured')
    const allowed = await pgQueryOne(
      "UPDATE travel_lookup_settings SET next_request_at=now()+interval '2 seconds' WHERE id=1 AND next_request_at<=now() RETURNING id",
    )
    if (!allowed) throw new HttpError(429, 'Place lookup is busy. Please try again shortly.', 2)
    url.search = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      addressdetails: '1',
      limit: '5',
      'accept-language': 'en',
    }).toString()
    let results: AlbumPlace[] = []
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': `PersonalPhotos/1.0 (+${deployment.GATEWAY_ORIGIN})`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      })
      if (response.status === 429 || response.status === 403)
        await pgQuery(
          "UPDATE travel_lookup_settings SET next_request_at=now()+interval '1 hour' WHERE id=1",
        )
      if (!response.ok) throw Error('Lookup failed')
      const data = await response.json()
      if (!Array.isArray(data)) throw Error('Invalid response')
      results = data.slice(0, 5).flatMap((row) => {
        try {
          return [
            validatePlace({
              ...parsePlaceName(row),
              label: row.display_name,
              lat: Number(row.lat),
              lng: Number(row.lon),
            }),
          ]
        } catch {
          return []
        }
      })
    } catch {
      throw new HttpError(502, 'Place lookup is unavailable. Please try again later.')
    }
    await pgQuery(
      'INSERT INTO travel_search_cache(query,results) VALUES($1,$2::jsonb) ON CONFLICT(query) DO UPDATE SET results=EXCLUDED.results,updated_at=now()',
      [query, JSON.stringify(results)],
    )
    return results
  })
  if (result === null)
    throw new HttpError(429, 'Place lookup is busy. Please try again shortly.', 2)
  return result
}

export function searchPlaces(...args: Parameters<typeof searchPlacesService>) {
  return withServiceDatabase(() => searchPlacesService(...args))
}
