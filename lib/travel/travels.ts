import { travelSummaryOverviewSql, travelSummaryViewportSql } from './travel-summary-query'
import { TRAVEL_MAX_ZOOM } from './travel-clusters'
import { pgQuery, pgReadIdentity } from '@/lib/postgres'
import { ALBUM_READ_SQL } from '@/lib/albums/album-sql'
import { HttpError } from '@/lib/http'
import { albumCaller } from '@/lib/albums/album-access'
import { flagOn } from '../flags'

export interface TravelStop {
  gpsLat?: number | null
  gpsLng?: number | null
  eventId: number
  album: string
  year: number | null
  lat: number | null
  lng: number | null
  placeLookupDeferred?: boolean
  placeName?: string
  placeCountry?: string
  country: string
  city: string
  count: number
  photoId: number
  thumbnail: string | null
}
export async function travelStops(scope: 'mine' | 'accessible'): Promise<TravelStop[]> {
  const caller = await albumCaller()
  return pgReadIdentity(caller, async () => {
    const rows = await pgQuery<Record<string, unknown>>(
      flagOn('TRAVEL_SUMMARIES_ENABLED')
        ? travelSummaryOverviewSql
        : `WITH source AS (
 SELECT p.photo_id,p.event_id,p.date_taken,p.country,p.city,p.thumbnail_stage_path,e.event_name,e.event_year,
 CASE WHEN p.latitude BETWEEN -90 AND 90 AND p.longitude BETWEEN -180 AND 180
 THEN round(p.latitude::numeric,1)::float8 END AS lat,
 CASE WHEN p.latitude BETWEEN -90 AND 90 AND p.longitude BETWEEN -180 AND 180
 THEN round(p.longitude::numeric,1)::float8 END AS lng
 FROM photos p JOIN events e ON e.event_id=p.event_id
 WHERE ${ALBUM_READ_SQL} AND ($3::boolean OR e.owner_username=$1)
 ), grouped AS (SELECT event_id,event_name,COALESCE(EXTRACT(YEAR FROM date_taken AT TIME ZONE 'UTC')::int,event_year) AS year,
 lat,lng,COALESCE(NULLIF(trim(country),''),'') AS country,COALESCE(NULLIF(trim(city),''),'') AS city,
 count(*)::int AS count,COALESCE(min(photo_id) FILTER(WHERE thumbnail_stage_path IS NOT NULL),min(photo_id)) AS photo_id
 FROM source GROUP BY event_id,event_name,year,lat,lng,COALESCE(NULLIF(trim(country),''),''),COALESCE(NULLIF(trim(city),''),'')
 ) SELECT g.*,p.thumbnail_stage_path AS thumbnail FROM grouped g JOIN photos p ON p.photo_id=g.photo_id
 ORDER BY year DESC NULLS LAST,g.event_id,lat,lng`,
      [caller.username, caller.mainAdmin, scope === 'accessible'],
    )
    return rows.map((r) => ({
      gpsLat: r.gps_lat == null ? null : Number(r.gps_lat),
      gpsLng: r.gps_lng == null ? null : Number(r.gps_lng),
      eventId: Number(r.event_id),
      album: String(r.event_name),
      year: r.year == null ? null : Number(r.year),
      lat: r.lat == null ? null : Number(r.lat),
      lng: r.lng == null ? null : Number(r.lng),
      country: String(r.country),
      city: String(r.city),
      count: Number(r.count),
      photoId: Number(r.photo_id),
      thumbnail: r.thumbnail ? String(r.thumbnail) : null,
    }))
  })
}

export function parseViewport(params: URLSearchParams) {
  const names = ['south', 'north', 'west', 'east', 'zoom'] as const
  const values = names.map((name) => {
    const value = params.get(name)
    if (value === null || !value.trim() || !Number.isFinite(Number(value)))
      throw new HttpError(400, 'Invalid map viewport')
    return Number(value)
  })
  const [south, north, west, east, zoom] = values
  if (
    south < -90 ||
    north > 90 ||
    south >= north ||
    west < -180 ||
    east > 180 ||
    west >= east ||
    zoom < 0 ||
    zoom > TRAVEL_MAX_ZOOM
  )
    throw new HttpError(400, 'Invalid map viewport')
  const year = params.get('year') ?? 'all'
  if (!['all', 'undated'].includes(year) && !/^\d{1,4}$/.test(year))
    throw new HttpError(400, 'Invalid map year')
  // Bound the grid in both dimensions even for unusual/wide viewports. Never truncate counts.
  const step = Math.max(360 / (2 ** Math.floor(zoom) * 4), (north - south) / 32, (east - west) / 32)
  return { south, north, west, east, step, year }
}
export async function viewportClusters(scope: 'mine' | 'accessible', params: URLSearchParams) {
  const v = parseViewport(params)
  const caller = await albumCaller()
  return pgReadIdentity(caller, async () => {
    const rows = await pgQuery<{
      x: number
      y: number
      lat: number
      lng: number
      count: number
      points: number
      area_lat: number
      area_lng: number
    }>(
      flagOn('TRAVEL_SUMMARIES_ENABLED')
        ? travelSummaryViewportSql
        : `
 WITH cells AS (SELECT floor(p.longitude/$8)::int AS x,floor(p.latitude/$8)::int AS y,
 avg(p.latitude)::float8 AS lat,avg(p.longitude)::float8 AS lng,count(*)::int AS count,
 count(DISTINCT (p.latitude,p.longitude))::int AS points,
 min(p.photo_id) AS representative
 FROM photos p JOIN events e ON e.event_id=p.event_id
 WHERE ${ALBUM_READ_SQL} AND ($3::boolean OR e.owner_username=$1)
 AND p.latitude BETWEEN $4 AND $5 AND p.longitude BETWEEN $6 AND $7
 AND ($9='all' OR ($9='undated' AND COALESCE(EXTRACT(YEAR FROM p.date_taken AT TIME ZONE 'UTC')::int,e.event_year) IS NULL)
 OR COALESCE(EXTRACT(YEAR FROM p.date_taken AT TIME ZONE 'UTC')::int,e.event_year)::text=$9)
 GROUP BY x,y) SELECT c.*,round(p.latitude::numeric,1)::float8 AS area_lat,round(p.longitude::numeric,1)::float8 AS area_lng FROM cells c JOIN photos p ON p.photo_id=c.representative ORDER BY x,y`,
      [
        caller.username,
        caller.mainAdmin,
        scope === 'accessible',
        v.south,
        v.north,
        v.west,
        v.east,
        v.step,
        v.year,
      ],
    )
    return rows.map((r) => ({
      id: `${r.x}:${r.y}`,
      lat: Number(r.lat),
      lng: Number(r.lng),
      count: Number(r.count),
      points: Number(r.points),
      areaId: `${r.area_lat},${r.area_lng}`,
      label: '',
    }))
  })
}
