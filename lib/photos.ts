import { type AlbumCaller, canEditAlbum } from './albums/album-access'
import { photoFilters } from '@/lib/photos/photo-filters'
import { HttpError } from '@/lib/http'
import { pgQuery, pgQueryOne, pgReadIdentity, pgTransaction } from '@/lib/postgres'
import { lockManagement } from './database/management-lock'
import { albumReadSql } from './albums/album-sql'

export interface Photo {
  photoId: number
  eventId: number
  sourceFilename: string
  originalStagePath: string | null
  displayStagePath: string | null
  thumbnailStagePath: string | null
  fileSizeBytes: number | null
  contentType: string | null
  fileExtension: string | null
  fileHash: string | null
  width: number | null
  height: number | null
  aspectRatio: number | null
  orientation: number | null
  dateTaken: string | null
  cameraMake: string | null
  cameraModel: string | null
  lensModel: string | null
  lensMake: string | null
  lensSerial: string | null
  software: string | null
  artist: string | null
  copyright: string | null
  focalLength: string | null
  aperture: string | null
  shutterSpeed: string | null
  iso: number | null
  exposureCompensation: string | null
  flashUsed: boolean | null
  exposureProgram: string | null
  meteringMode: string | null
  lightSource: string | null
  whiteBalance: string | null
  exposureMode: string | null
  sceneCaptureType: string | null
  contrast: string | null
  saturation: string | null
  sharpness: string | null
  brightness: string | null
  focalLength35mm: string | null
  digitalZoomRatio: string | null
  colorSpace: string | null
  subjectDistanceRange: string | null
  locationManuallyAssigned?: boolean
  latitude: number | null
  longitude: number | null
  altitude: number | null
  gpsDirection: number | null
  gpsSpeed: number | null
  gpsTimestamp: string | null
  gpsHPositioningError: number | null
  country: string | null
  region: string | null
  city: string | null
  locationName: string | null
  iptcKeywords: string[] | null
  iptcHeadline: string | null
  iptcCopyright: string | null
  exifRaw: unknown | null
  xmpRaw: unknown | null
  iptcRaw: unknown | null
  iccRaw: unknown | null
  caption: string | null
  userTags: string[]
  aiDescription: string | null
  aiTags: string[] | null
  favorite: boolean
  rating: number | null
  ingestStatus: string
  ingestError: string | null
  mediaType: string
  duration: number | null
}

/** How a column value from the database driver becomes a `Photo` property value. */
const requiredNumber = (value: unknown): number => Number(value)
const requiredText = (value: unknown): string => String(value)
const text = (value: unknown): string | null => (value ? String(value) : null)
const number = (value: unknown): number | null => (value != null ? Number(value) : null)
const timestamp = (value: unknown): string | null =>
  value ? (value instanceof Date ? value.toISOString() : String(value)) : null
const flag = (value: unknown): boolean => Boolean(value)
const optionalFlag = (value: unknown): boolean | null => (value != null ? Boolean(value) : null)
const textList = (value: unknown): string[] | null =>
  Array.isArray(value) ? value.map(String) : null
const textListOrEmpty = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : []
const json = (value: unknown): unknown => value ?? null
const textOr =
  (fallback: string) =>
  (value: unknown): string =>
    String(value ?? fallback)

/**
 * One row of the photo column table.
 *
 * - `column`: the name in the `photos` table (or, for `location_assignment_id`, in the row
 *   a reader selects).
 * - `property` and `read`: the `Photo` property this column fills and how the stored value
 *   is converted. Leave both out for a column that is written but never read into a `Photo`.
 * - `insert`: the `NewPhoto` property that `insertPhoto` stores in this column. Leave it out
 *   for a column that is filled later or by the database.
 * - `insertCast`: a SQL cast applied to the inserted parameter.
 * - `insertDefault`: the value stored when the `NewPhoto` property is missing or null.
 */
type PhotoColumn = { column: string } & (
  | { property: string; read: (value: unknown) => unknown }
  | { property?: undefined; read?: undefined }
) & { insert?: string; insertCast?: 'jsonb'; insertDefault?: string | null }

/**
 * Every photo column, defined once. `mapPhoto` and `insertPhoto` are both driven by this
 * table, so adding a column is one line here plus its property on `Photo` (and on `NewPhoto`
 * if it is inserted); the checks below fail to compile if the table and those types disagree.
 * Insert parameters are numbered in table order.
 */
export const PHOTO_COLUMNS = [
  { column: 'photo_id', property: 'photoId', read: requiredNumber },
  { column: 'event_id', property: 'eventId', read: requiredNumber, insert: 'eventId' },
  {
    column: 'source_filename',
    property: 'sourceFilename',
    read: requiredText,
    insert: 'sourceFilename',
  },
  { column: 'source_relative_path', insert: 'sourceRelativePath' },
  {
    column: 'original_stage_path',
    property: 'originalStagePath',
    read: text,
    insert: 'originalStagePath',
  },
  { column: 'display_stage_path', property: 'displayStagePath', read: text },
  { column: 'thumbnail_stage_path', property: 'thumbnailStagePath', read: text },
  { column: 'file_size_bytes', property: 'fileSizeBytes', read: number, insert: 'fileSizeBytes' },
  { column: 'content_type', property: 'contentType', read: text, insert: 'contentType' },
  { column: 'file_extension', property: 'fileExtension', read: text, insert: 'fileExtension' },
  { column: 'file_hash', property: 'fileHash', read: text, insert: 'fileHash' },
  { column: 'width', property: 'width', read: number, insert: 'width' },
  { column: 'height', property: 'height', read: number, insert: 'height' },
  { column: 'aspect_ratio', property: 'aspectRatio', read: number, insert: 'aspectRatio' },
  { column: 'orientation', property: 'orientation', read: number, insert: 'orientation' },
  { column: 'date_taken', property: 'dateTaken', read: timestamp, insert: 'dateTaken' },
  { column: 'camera_make', property: 'cameraMake', read: text, insert: 'cameraMake' },
  { column: 'camera_model', property: 'cameraModel', read: text, insert: 'cameraModel' },
  { column: 'lens_model', property: 'lensModel', read: text, insert: 'lensModel' },
  { column: 'lens_make', property: 'lensMake', read: text, insert: 'lensMake' },
  { column: 'lens_serial', property: 'lensSerial', read: text, insert: 'lensSerial' },
  { column: 'software', property: 'software', read: text, insert: 'software' },
  { column: 'artist', property: 'artist', read: text, insert: 'artist' },
  { column: 'copyright', property: 'copyright', read: text, insert: 'copyright' },
  { column: 'focal_length', property: 'focalLength', read: text, insert: 'focalLength' },
  { column: 'aperture', property: 'aperture', read: text, insert: 'aperture' },
  { column: 'shutter_speed', property: 'shutterSpeed', read: text, insert: 'shutterSpeed' },
  { column: 'iso', property: 'iso', read: number, insert: 'iso' },
  {
    column: 'exposure_compensation',
    property: 'exposureCompensation',
    read: text,
    insert: 'exposureCompensation',
  },
  { column: 'flash_used', property: 'flashUsed', read: optionalFlag, insert: 'flashUsed' },
  {
    column: 'exposure_program',
    property: 'exposureProgram',
    read: text,
    insert: 'exposureProgram',
  },
  { column: 'metering_mode', property: 'meteringMode', read: text, insert: 'meteringMode' },
  { column: 'light_source', property: 'lightSource', read: text, insert: 'lightSource' },
  { column: 'white_balance', property: 'whiteBalance', read: text, insert: 'whiteBalance' },
  { column: 'exposure_mode', property: 'exposureMode', read: text, insert: 'exposureMode' },
  {
    column: 'scene_capture_type',
    property: 'sceneCaptureType',
    read: text,
    insert: 'sceneCaptureType',
  },
  { column: 'contrast', property: 'contrast', read: text, insert: 'contrast' },
  { column: 'saturation', property: 'saturation', read: text, insert: 'saturationVal' },
  { column: 'sharpness', property: 'sharpness', read: text, insert: 'sharpnessVal' },
  { column: 'brightness', property: 'brightness', read: text, insert: 'brightness' },
  {
    column: 'focal_length_35mm',
    property: 'focalLength35mm',
    read: text,
    insert: 'focalLength35mm',
  },
  {
    column: 'digital_zoom_ratio',
    property: 'digitalZoomRatio',
    read: text,
    insert: 'digitalZoomRatio',
  },
  { column: 'color_space', property: 'colorSpace', read: text, insert: 'colorSpace' },
  {
    column: 'subject_distance_range',
    property: 'subjectDistanceRange',
    read: text,
    insert: 'subjectDistanceRange',
  },
  { column: 'location_assignment_id', property: 'locationManuallyAssigned', read: flag },
  { column: 'latitude', property: 'latitude', read: number, insert: 'latitude' },
  { column: 'longitude', property: 'longitude', read: number, insert: 'longitude' },
  { column: 'altitude', property: 'altitude', read: number, insert: 'altitude' },
  { column: 'gps_direction', property: 'gpsDirection', read: number, insert: 'gpsDirection' },
  { column: 'gps_speed', property: 'gpsSpeed', read: number, insert: 'gpsSpeed' },
  { column: 'gps_timestamp', property: 'gpsTimestamp', read: timestamp, insert: 'gpsTimestamp' },
  {
    column: 'gps_h_positioning_error',
    property: 'gpsHPositioningError',
    read: number,
    insert: 'gpsHPositioningError',
  },
  { column: 'country', property: 'country', read: text },
  { column: 'region', property: 'region', read: text },
  { column: 'city', property: 'city', read: text },
  { column: 'location_name', property: 'locationName', read: text },
  { column: 'iptc_keywords', property: 'iptcKeywords', read: textList, insert: 'iptcKeywords' },
  { column: 'iptc_headline', property: 'iptcHeadline', read: text, insert: 'iptcHeadline' },
  { column: 'iptc_copyright', property: 'iptcCopyright', read: text, insert: 'iptcCopyright' },
  { column: 'date_taken_raw', insert: 'dateTakenRaw' },
  { column: 'exif_raw', property: 'exifRaw', read: json, insert: 'exifRaw', insertCast: 'jsonb' },
  { column: 'xmp_raw', property: 'xmpRaw', read: json, insert: 'xmpRaw', insertCast: 'jsonb' },
  { column: 'iptc_raw', property: 'iptcRaw', read: json, insert: 'iptcRaw', insertCast: 'jsonb' },
  { column: 'icc_raw', property: 'iccRaw', read: json, insert: 'iccRaw', insertCast: 'jsonb' },
  { column: 'caption', property: 'caption', read: text },
  { column: 'user_tags', property: 'userTags', read: textListOrEmpty },
  { column: 'ai_description', property: 'aiDescription', read: text },
  { column: 'ai_tags', property: 'aiTags', read: textList },
  { column: 'favorite', property: 'favorite', read: flag },
  { column: 'rating', property: 'rating', read: number },
  {
    column: 'ingest_status',
    property: 'ingestStatus',
    read: textOr('DISCOVERED'),
    insert: 'ingestStatus',
  },
  { column: 'ingest_error', property: 'ingestError', read: text },
  {
    column: 'media_type',
    property: 'mediaType',
    read: textOr('photo'),
    insert: 'mediaType',
    insertDefault: 'photo',
  },
  {
    column: 'duration',
    property: 'duration',
    read: number,
    insert: 'duration',
    insertDefault: null,
  },
] as const satisfies readonly PhotoColumn[]

type AnyPhotoColumn = (typeof PHOTO_COLUMNS)[number]
type ReadPhotoColumn = Extract<AnyPhotoColumn, { property: string }>
type InsertPhotoColumn = Extract<AnyPhotoColumn, { insert: string }>
/** The object shape the table produces: each read column's property and converted type. */
type MappedPhoto = { [Column in ReadPhotoColumn as Column['property']]: ReturnType<Column['read']> }
type Same<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false

// Compile-time agreement between the table and the hand-written types. If one of these lines
// reports "Type 'true' does not satisfy the expected type 'false'", a property or its type is
// in the table but not the interface, or the other way round.
true satisfies Same<MappedPhoto, Required<Photo>>
true satisfies Same<InsertPhotoColumn['insert'], keyof NewPhoto>

const READ_PHOTO_COLUMNS = PHOTO_COLUMNS.filter(
  (column): column is ReadPhotoColumn => 'property' in column,
)
const INSERT_PHOTO_COLUMNS = PHOTO_COLUMNS.filter(
  (column): column is InsertPhotoColumn => 'insert' in column,
)

function mapPhoto(row: Record<string, unknown>): Photo {
  return Object.fromEntries(
    READ_PHOTO_COLUMNS.map((column) => [column.property, column.read(row[column.column])]),
  ) as MappedPhoto
}

export async function getPhoto(photoId: number): Promise<Photo | null> {
  const row = await pgQueryOne(`SELECT * FROM photos WHERE photo_id = $1`, [photoId])
  return row ? mapPhoto(row) : null
}

/** Photo and live album ACL are read in the same statement under the caller's RLS scope. */
export async function getAuthorizedPhoto(photoId: number, caller: AlbumCaller) {
  const row = await pgQueryOne<Record<string, unknown>>(
    `SELECT p.*,e.owner_username AS album_owner,e.cover_photo_id AS album_cover
     FROM photos p JOIN events e ON e.event_id=p.event_id
     WHERE p.photo_id=$1 AND ${albumReadSql(2, 3)}`,
    [photoId, caller.username, caller.mainAdmin],
  )
  if (!row) return null
  return {
    photo: mapPhoto(row),
    canEdit: canEditAlbum(caller, String(row.album_owner)),
    coverPhotoId: row.album_cover == null ? null : Number(row.album_cover),
  }
}

/** Bounded seeks use exactly the same validated sort and filters as gallery pages. */
function neighborQuery(
  params: URLSearchParams,
  scope: string,
  photo: string,
  firstParameter: number,
) {
  const filters = photoFilters(params)
  const values = [
    filters.media,
    filters.favorite,
    filters.from,
    filters.to,
    filters.camera,
    filters.location,
  ]
  const [media, favorite, from, to, camera, location] = values.map(
    (_value, index) => `$${firstParameter + index}`,
  )
  const allowed = `${scope} AND ingest_status='READY'
    AND (${media}::text IS NULL OR media_type=${media}) AND (NOT ${favorite}::boolean OR favorite=true)
    AND (${from}::date IS NULL OR COALESCE(date_taken,created_at)>=${from}::date)
    AND (${to}::date IS NULL OR COALESCE(date_taken,created_at)<${to}::date+INTERVAL '1 day')
    AND (${camera}::text IS NULL OR strpos(lower(concat_ws(' ',camera_make,camera_model)),lower(${camera}))>0)
    AND (${location}::text IS NULL OR strpos(lower(concat_ws(' ',country,region,city,location_name)),lower(${location}))>0)`
  const direction = filters.descending ? 'DESC' : 'ASC'
  const reverse = filters.descending ? 'ASC' : 'DESC'
  const seek = (op: string, order: string, offset = 0) =>
    `(SELECT photo_id FROM photos WHERE ${allowed} AND (${filters.key},photo_id)${op}(c.k,c.photo_id)
      ORDER BY ${filters.key} ${order},photo_id ${order} OFFSET ${offset} LIMIT 1)`
  return {
    values,
    sql: `WITH current_photo AS (
    SELECT photo_id,${filters.key} AS k FROM photos WHERE photo_id=${photo} AND ${allowed}
  ), neighbors AS (
    SELECT ${seek(filters.descending ? '>' : '<', reverse)} AS prev,
      ${seek(filters.descending ? '<' : '>', direction)} AS next,
      ${seek(filters.descending ? '<' : '>', direction, 1)} AS next2 FROM current_photo c
  )`,
  }
}
export async function getAdjacentFavorites(
  photoId: number,
  params: URLSearchParams,
  allowedIds: number[],
  preload = false,
) {
  const query = neighborQuery(params, 'event_id=ANY($2::int[]) AND favorite=true', '$1', 3)
  const row = await pgQueryOne<{ prev: number | null; next: number | null; next2: number | null }>(
    `${query.sql} SELECT * FROM neighbors`,
    [photoId, allowedIds, ...query.values],
  )
  return {
    prev: row?.prev ?? null,
    next: row?.next ?? null,
    ...(preload ? { next2: row?.next2 ?? null } : {}),
  }
}

/** Common album viewer: detail, bounded neighbors and preload rows in one reader statement. */
export async function getPhotoViewerPage(
  photoId: number,
  caller: AlbumCaller,
  params = new URLSearchParams(),
) {
  return pgReadIdentity(
    caller,
    async () => {
      const neighbor = neighborQuery(
        params,
        'event_id=current_record.event_id',
        'current_record.photo_id',
        4,
      )
      const row = await pgQueryOne<Record<string, any>>(
        `SELECT current_record.*,e.owner_username AS album_owner,e.cover_photo_id AS album_cover,
       nav.prev,nav.next,nav.next2,
       COALESCE((SELECT json_agg(preload) FROM (
         SELECT photo_id,display_stage_path,width,height FROM photos
         WHERE current_record.media_type='photo' AND event_id=current_record.event_id
           AND ingest_status='READY' AND media_type='photo' AND display_stage_path IS NOT NULL
           AND photo_id=ANY(ARRAY[nav.next,nav.next2,nav.prev]) LIMIT 3
       ) preload),'[]'::json) AS candidates
       FROM photos current_record JOIN events e ON e.event_id=current_record.event_id
       LEFT JOIN LATERAL (${neighbor.sql} SELECT * FROM neighbors) nav ON true
       WHERE current_record.photo_id=$1 AND ${albumReadSql(2, 3)}`,
        [photoId, caller.username, caller.mainAdmin, ...neighbor.values],
      )
      if (!row) return null
      return {
        photo: mapPhoto(row),
        canEdit: canEditAlbum(caller, String(row.album_owner)),
        coverPhotoId: row.album_cover == null ? null : Number(row.album_cover),
        adjacent: { prev: row.prev ?? null, next: row.next ?? null, next2: row.next2 ?? null },
        candidates: row.candidates as {
          photo_id: number
          display_stage_path: string
          width: number | null
          height: number | null
        }[],
      }
    },
    { singleQuery: true, disableJit: true },
  )
}

export async function toggleFavorite(photoId: number): Promise<boolean> {
  const updated = await pgQueryOne<{ favorite: boolean }>(
    `UPDATE photos SET favorite = NOT favorite, updated_at = NOW() WHERE photo_id = $1 RETURNING favorite`,
    [photoId],
  )
  if (!updated) throw new HttpError(404, 'Photo not found')
  return updated.favorite
}

export async function checkDuplicateHash(eventId: number, hash: string): Promise<number | null> {
  const duplicate = await pgQueryOne<{ photo_id: number }>(
    `SELECT photo_id FROM photos WHERE event_id = $1 AND file_hash = $2`,
    [eventId, hash],
  )
  return duplicate?.photo_id ?? null
}

/** The values `insertPhoto` stores for a newly uploaded photo or video. */
export interface NewPhoto {
  eventId: number
  sourceFilename: string
  sourceRelativePath: string
  originalStagePath: string
  fileSizeBytes: number
  contentType: string
  fileExtension: string
  fileHash: string
  width: number | null
  height: number | null
  aspectRatio: number | null
  orientation: number | null
  dateTaken: string | null
  cameraMake: string | null
  cameraModel: string | null
  lensModel: string | null
  lensMake: string | null
  lensSerial: string | null
  software: string | null
  artist: string | null
  copyright: string | null
  focalLength: string | null
  aperture: string | null
  shutterSpeed: string | null
  iso: number | null
  exposureCompensation: string | null
  flashUsed: boolean | null
  exposureProgram: string | null
  meteringMode: string | null
  lightSource: string | null
  whiteBalance: string | null
  exposureMode: string | null
  sceneCaptureType: string | null
  contrast: string | null
  saturationVal: string | null
  sharpnessVal: string | null
  brightness: string | null
  focalLength35mm: string | null
  digitalZoomRatio: string | null
  colorSpace: string | null
  subjectDistanceRange: string | null
  latitude: number | null
  longitude: number | null
  altitude: number | null
  gpsDirection: number | null
  gpsSpeed: number | null
  gpsTimestamp: string | null
  gpsHPositioningError: number | null
  iptcKeywords: string[] | null
  iptcHeadline: string | null
  iptcCopyright: string | null
  dateTakenRaw: string | null
  exifRaw: string | null
  xmpRaw: string | null
  iptcRaw: string | null
  iccRaw: string | null
  ingestStatus: string
  mediaType?: string
  duration?: number | null
}

/** The single INSERT statement for a new photo, built from the column table. */
export const INSERT_PHOTO_SQL = `INSERT INTO photos (
       ${INSERT_PHOTO_COLUMNS.map((column) => column.column).join(', ')}
     ) VALUES (
       ${INSERT_PHOTO_COLUMNS.map(
         (column, index) =>
           `$${index + 1}${'insertCast' in column ? `::${column.insertCast}` : ''}`,
       ).join(',')}
     )
     RETURNING photo_id`

/** The INSERT parameters for a new photo, in the same table order as the statement. */
export function insertPhotoValues(photo: NewPhoto): unknown[] {
  return INSERT_PHOTO_COLUMNS.map((column) => {
    const value = photo[column.insert]
    return 'insertDefault' in column ? (value ?? column.insertDefault) : value
  })
}

export async function insertPhoto(photo: NewPhoto): Promise<number> {
  const inserted = await pgQueryOne<{ photo_id: number }>(
    INSERT_PHOTO_SQL,
    insertPhotoValues(photo),
  )
  return inserted!.photo_id
}

export async function updatePhotoRenditions(
  photoId: number,
  displayPath: string,
  thumbnailPath: string | null,
): Promise<void> {
  await pgQuery(
    `UPDATE photos
     SET display_stage_path = $1, thumbnail_stage_path = $2, ingest_status = 'READY', updated_at = NOW()
     WHERE photo_id = $3`,
    [displayPath, thumbnailPath, photoId],
  )
}

export async function deletePhoto(photoId: number): Promise<{ eventId: number } | null> {
  return pgTransaction(async () => {
    await lockManagement()
    const existing = await pgQueryOne<{ event_id: number }>(
      'SELECT event_id FROM photos WHERE photo_id = $1',
      [photoId],
    )
    if (!existing) return null
    await pgQuery('SELECT pg_advisory_xact_lock($1)', [existing.event_id])
    await pgQuery(
      `INSERT INTO photo_trash(photo_id,photo_data,album_name)
      SELECT p.photo_id,to_jsonb(p),e.event_name FROM photos p JOIN events e ON e.event_id=p.event_id WHERE p.photo_id=$1`,
      [photoId],
    )
    const photo = await pgQueryOne('DELETE FROM photos WHERE photo_id = $1 RETURNING *', [photoId])
    if (!photo) return null
    await pgQuery(
      `UPDATE events SET cover_photo_id = CASE WHEN cover_photo_id = $1 THEN
      (SELECT photo_id FROM photos WHERE event_id = $2 AND ingest_status = 'READY' ORDER BY photo_id LIMIT 1)
      ELSE cover_photo_id END,
      photo_count = (SELECT COUNT(*) FROM photos WHERE event_id = $2 AND ingest_status = 'READY'), updated_at = NOW()
      WHERE event_id = $2`,
      [photoId, existing.event_id],
    )
    return { eventId: existing.event_id }
  })
}

/** At most three neighboring still images; full metadata and video bytes are never prefetched. */
export async function getViewerPreloadPhotos(
  ids: (number | null | undefined)[],
  allowedIds: number[],
) {
  return pgQuery<{
    photo_id: number
    display_stage_path: string
    width: number | null
    height: number | null
  }>(
    `SELECT photo_id,display_stage_path,width,height FROM photos
     WHERE photo_id=ANY($1::int[]) AND event_id=ANY($2::int[]) AND ingest_status='READY'
       AND media_type='photo' AND display_stage_path IS NOT NULL LIMIT 3`,
    [
      [...new Set(ids.filter((id): id is number => typeof id === 'number'))].slice(0, 3),
      allowedIds,
    ],
  )
}

/**
 * Sets or clears a photo's capture date and returns the updated row, or null when the
 * photo does not exist. Call inside `albumMutation` after a write-access check.
 */
export function setPhotoDateTaken(
  photoId: number,
  dateTaken: string | null,
): Promise<{ photo_id: number } | null> {
  return pgQueryOne<{ photo_id: number }>(
    'UPDATE photos SET date_taken=$2,updated_at=NOW() WHERE photo_id=$1 RETURNING photo_id',
    [photoId, dateTaken],
  )
}

export interface DownloadablePhoto {
  photo_id: number
  source_filename: string
  original_stage_path: string
  file_size_bytes: string
}

/**
 * Ready originals among the given photos, in ID order. Photos that are not ready or have
 * no original are absent. The caller must already have checked access to every ID.
 */
export function listDownloadablePhotos(photoIds: number[]): Promise<DownloadablePhoto[]> {
  return pgQuery<DownloadablePhoto>(
    `SELECT photo_id,source_filename,original_stage_path,file_size_bytes FROM photos WHERE photo_id=ANY($1::int[]) AND ingest_status='READY' AND original_stage_path IS NOT NULL ORDER BY photo_id`,
    [photoIds],
  )
}

/**
 * The original path of one photo if, right now, it exists, is ready and is in an album the
 * caller may read; otherwise null (trashed, moved out of reach, access withdrawn). Used to
 * re-authorize each file of a ZIP while it streams.
 */
export async function readDownloadablePath(
  photoId: number,
  caller: AlbumCaller,
): Promise<string | null> {
  const row = await pgQueryOne<{ original_stage_path: string }>(
    `SELECT p.original_stage_path FROM photos p JOIN events e ON e.event_id=p.event_id
     WHERE p.photo_id=$1 AND p.ingest_status='READY' AND p.original_stage_path IS NOT NULL
       AND ${albumReadSql(2, 3)}`,
    [photoId, caller.username, caller.mainAdmin],
  )
  return row?.original_stage_path ?? null
}

/**
 * Name, capture date and coordinates of the ready photos among the given IDs in one album,
 * in ID order. Call in the same transaction as the album access check.
 */
export function listAlbumPhotosForReview(
  eventId: number,
  photoIds: number[],
): Promise<Record<string, unknown>[]> {
  return pgQuery(
    'SELECT photo_id AS "photoId",source_filename AS "sourceFilename",date_taken AS "dateTaken",latitude,longitude FROM photos WHERE event_id=$1 AND photo_id=ANY($2::int[]) AND ingest_status=\'READY\' ORDER BY photo_id',
    [eventId, photoIds],
  )
}
