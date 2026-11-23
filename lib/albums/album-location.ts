import { randomUUID } from 'node:crypto'
import { albumCaller, albumMutation, requireAlbumAccess } from '@/lib/albums/album-access'
import { pgQuery, pgQueryOne } from '@/lib/postgres'
import { HttpError, textValue } from '@/lib/http'

export interface AlbumPlace {
  label: string
  lat: number
  lng: number
  city: string | null
  region: string | null
  country: string | null
}
export function validatePlace(value: unknown): AlbumPlace {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'Select a location')
  const p = value as Record<string, unknown>
  if (
    typeof p.lat !== 'number' ||
    !Number.isFinite(p.lat) ||
    Math.abs(p.lat) > 90 ||
    typeof p.lng !== 'number' ||
    !Number.isFinite(p.lng) ||
    Math.abs(p.lng) > 180
  )
    throw new HttpError(400, 'Invalid coordinates')
  return {
    label: textValue(p.label, 'place name', 500),
    lat: p.lat,
    lng: p.lng,
    city: p.city == null ? null : textValue(p.city, 'city', 200),
    region: p.region == null ? null : textValue(p.region, 'region', 200),
    country: p.country == null ? null : textValue(p.country, 'country', 200),
  }
}
export async function requireLocationEditor(eventId: number) {
  const c = await albumCaller()
  if (c.role === 'admin_readonly')
    throw new HttpError(403, 'Read-only administrators cannot change locations')
  return requireAlbumAccess(eventId, true, c)
}
export async function locationStatus(eventId: number) {
  await requireLocationEditor(eventId)
  const count = await pgQueryOne<{ count: number }>(
    "SELECT count(*)::int AS count FROM photos WHERE event_id=$1 AND ingest_status='READY' AND latitude IS NULL AND longitude IS NULL AND location_assignment_id IS NULL",
    [eventId],
  )
  const changes = await pgQuery(
    `SELECT c.id,c.label,c.applied_by,c.applied_at,count(p.photo_id)::int AS count
 FROM album_location_changes c JOIN photos p ON p.location_assignment_id=c.id AND p.event_id=c.event_id
 WHERE c.event_id=$1 AND c.undone_at IS NULL GROUP BY c.id ORDER BY c.applied_at DESC`,
    [eventId],
  )
  return { eligible: count?.count ?? 0, changes }
}
export async function applyAlbumLocation(eventId: number, value: unknown) {
  const p = validatePlace(value)
  return albumMutation(
    async (c) => {
      if (c.role === 'admin_readonly')
        throw new HttpError(403, 'Read-only administrators cannot change locations')
      await requireAlbumAccess(eventId, true, c)
      const rows = await pgQuery<{ photo_id: number; previous: unknown }>(
        `SELECT photo_id,jsonb_build_object('latitude',latitude,'longitude',longitude,'city',city,'region',region,'country',country,'location_name',location_name) AS previous
   FROM photos WHERE event_id=$1 AND ingest_status='READY' AND latitude IS NULL AND longitude IS NULL AND location_assignment_id IS NULL FOR UPDATE`,
        [eventId],
      )
      if (!rows.length) return { count: 0 }
      const id = randomUUID()
      await pgQuery(
        'INSERT INTO album_location_changes(id,event_id,label,latitude,longitude,applied_by) VALUES($1,$2,$3,$4,$5,$6)',
        [id, eventId, p.label, p.lat, p.lng, c.username],
      )
      await pgQuery(
        `INSERT INTO album_location_items(change_id,photo_id,previous) SELECT $1,x.photo_id,x.previous FROM jsonb_to_recordset($2::jsonb) AS x(photo_id int,previous jsonb)`,
        [id, JSON.stringify(rows)],
      )
      await pgQuery(
        `UPDATE photos SET latitude=$1,longitude=$2,city=$3,region=$4,country=$5,location_name=$6,location_assignment_id=$7,updated_at=now() WHERE photo_id=ANY($8::int[])`,
        [p.lat, p.lng, p.city, p.region, p.country, p.label, id, rows.map((r) => r.photo_id)],
      )
      return { count: rows.length, id }
    },
    { eventIds: [eventId] },
  )
}
export async function undoAlbumLocation(eventId: number, id: unknown) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))
    throw new HttpError(400, 'Invalid location change')
  return albumMutation(
    async (c) => {
      if (c.role === 'admin_readonly')
        throw new HttpError(403, 'Read-only administrators cannot change locations')
      await requireAlbumAccess(eventId, true, c)
      const change = await pgQueryOne(
        'SELECT id FROM album_location_changes WHERE id=$1 AND event_id=$2 AND undone_at IS NULL FOR UPDATE',
        [id, eventId],
      )
      if (!change) throw new HttpError(404, 'Location change not found')
      const rows = await pgQuery(
        `UPDATE photos p SET latitude=(i.previous->>'latitude')::float8,longitude=(i.previous->>'longitude')::float8,
   city=i.previous->>'city',region=i.previous->>'region',country=i.previous->>'country',location_name=i.previous->>'location_name',location_assignment_id=NULL,updated_at=now()
   FROM album_location_items i,album_location_changes c WHERE i.change_id=$1 AND c.id=i.change_id AND p.photo_id=i.photo_id AND p.event_id=$2 AND p.location_assignment_id=$1
   AND p.latitude=c.latitude AND p.longitude=c.longitude AND p.location_name=c.label RETURNING p.photo_id`,
        [id, eventId],
      )
      await pgQuery('UPDATE album_location_changes SET undone_at=now() WHERE id=$1', [id])
      return { count: rows.length }
    },
    { eventIds: [eventId] },
  )
}
