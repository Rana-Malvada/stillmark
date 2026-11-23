import { pgPageRows } from '../database/postgres-page-rows'
import { pgQueryOne } from '../postgres'
import { type AlbumCaller, canEditAlbum } from '../albums/album-access'
import { photoFilters } from './photo-filters'
import { HttpError } from '../http'
import { albumReadSql } from '../albums/album-sql'

/** Username is bound as $11 and the main-administrator flag as $12 in these queries. */
const READABLE_ALBUM = albumReadSql(11, 12)
export interface PhotoSummary {
  photoId: number
  eventId: number
  sourceFilename: string
  thumbnailStagePath: string | null
  displayStagePath: string | null
  originalStagePath: string | null
  aspectRatio: number | null
  mediaType: string
  favorite: boolean
  eventName?: string
  caption?: string | null
  canEdit?: boolean
}
async function loadPhotoPage(eventId: number | null, params: URLSearchParams, caller: AlbumCaller) {
  const f = photoFilters(params)
  const sort = f.sort
  const key = f.key
  const desc = f.descending
  const direction = desc ? 'DESC' : 'ASC'
  const operator = desc ? '<' : '>'
  const limit = 96
  const filter = new URLSearchParams(params)
  filter.delete('cursor')
  filter.delete('paged')
  const signature = JSON.stringify([...filter.entries()].sort())
  let cursor: { key: string; id: number; filter: string } | null = null
  if (params.get('cursor')) {
    try {
      if (params.get('cursor')!.length > 4096) throw Error()
      cursor = JSON.parse(Buffer.from(params.get('cursor')!, 'base64url').toString())
      if (
        !cursor ||
        typeof cursor.key !== 'string' ||
        cursor.key.length > 1024 ||
        !Number.isSafeInteger(cursor.id) ||
        cursor.id < 1 ||
        cursor.filter !== signature
      )
        throw Error()
      if (sort !== 'name' && !Number.isFinite(Date.parse(cursor.key))) throw Error()
    } catch {
      throw new HttpError(400, 'Invalid photo page cursor')
    }
  }
  // The favorites view spans albums, so each row also carries its album's owner and name.
  const albumColumns =
    eventId === null
      ? `caption,
        (SELECT e.owner_username FROM events e WHERE e.event_id=photos.event_id) AS album_owner,
        (SELECT e.event_name FROM events e WHERE e.event_id=photos.event_id) AS event_name,`
      : ''
  const sql = `SELECT ${albumColumns}photo_id,event_id,source_filename,thumbnail_stage_path,
  display_stage_path,original_stage_path,aspect_ratio,media_type,favorite,${key}::text AS cursor_key
 FROM photos WHERE ${eventId === null ? `favorite=true AND EXISTS(SELECT 1 FROM events e WHERE e.event_id=photos.event_id AND ${READABLE_ALBUM}) AND $1::int IS NULL` : 'event_id=$1'} AND ingest_status='READY'
 AND ($2::text IS NULL OR media_type=$2) AND (NOT $3::boolean OR favorite=true)
 AND ($4::date IS NULL OR COALESCE(date_taken,created_at)>=$4::date)
 AND ($5::date IS NULL OR COALESCE(date_taken,created_at)<$5::date+INTERVAL '1 day')
 AND ($6::text IS NULL OR strpos(lower(concat_ws(' ',camera_make,camera_model)),lower($6))>0)
 AND ($7::text IS NULL OR strpos(lower(concat_ws(' ',country,region,city,location_name)),lower($7))>0)
 AND ($8::text IS NULL OR (${key},photo_id) ${operator} ($8::${sort === 'name' ? 'text' : 'timestamptz'},$9::int))
 ORDER BY ${key} ${direction},photo_id ${direction} LIMIT $10`
  const values = [
    eventId,
    f.media,
    f.favorite,
    f.from,
    f.to,
    f.camera,
    f.location,
    cursor?.key ?? null,
    cursor?.id ?? null,
    limit + 1,
  ]
  let rows: Record<string, any>[]
  if (eventId === null) {
    rows = await pgPageRows<Record<string, any>>(sql, [
      ...values,
      caller.username,
      caller.mainAdmin,
    ])
  } else {
    const row = await pgQueryOne<{ page_rows: Record<string, any>[] }>(
      `SELECT COALESCE((SELECT json_agg(page_rows) FROM (${sql}) page_rows),'[]'::json) AS page_rows
       FROM events e WHERE e.event_id=$1 AND ${READABLE_ALBUM}`,
      [...values, caller.username, caller.mainAdmin],
    )
    if (!row) throw new HttpError(404, 'Album not found')
    if (!Array.isArray(row.page_rows)) throw new Error('Invalid database page result')
    rows = row.page_rows
  }
  const more = rows.length > limit
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    items: items.map(
      (r) =>
        ({
          photoId: Number(r.photo_id),
          eventId: Number(r.event_id),
          sourceFilename: r.source_filename,
          thumbnailStagePath: r.thumbnail_stage_path,
          displayStagePath: r.display_stage_path,
          originalStagePath: r.original_stage_path,
          aspectRatio: r.aspect_ratio,
          mediaType: r.media_type ?? 'photo',
          favorite: r.favorite,
          ...(eventId === null
            ? {
                eventName: r.event_name,
                caption: r.caption,
                canEdit: canEditAlbum(caller, String(r.album_owner)),
              }
            : {}),
        }) as PhotoSummary,
    ),
    nextCursor:
      more && last
        ? Buffer.from(
            JSON.stringify({ key: last.cursor_key, id: Number(last.photo_id), filter: signature }),
          ).toString('base64url')
        : null,
  }
}

/** Caller must be obtained from albumCaller; the existing transaction retains RLS. */
export function authorizedPhotoPage(eventId: number, params: URLSearchParams, caller: AlbumCaller) {
  return loadPhotoPage(eventId, params, caller)
}

/** Bounded cross-album favorites; RLS and live ACL apply to every page. */
export function favoritePhotoPage(params: URLSearchParams, caller: AlbumCaller) {
  return loadPhotoPage(null, params, caller)
}
