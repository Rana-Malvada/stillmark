import { pgQuery, pgQueryOne } from '../postgres'
import { publicSelection, selectedPhotos } from '../albums/public-selection'

/**
 * Reads for public share links. A link is the value returned by `publicAlbum`, which has
 * already validated the token; rows are limited to that link's album and selection.
 */
type PublicLink = { event_id: number; photo_ids?: number[] | null }

export interface PublicPhotoListing {
  photo_id: number
  source_filename: string
  media_type: string
}

export interface PublicPhotoMedia {
  thumbnail_stage_path: string
  display_stage_path: string
  original_stage_path: string
  media_type: string
}

export interface PublicDownloadPhoto {
  photo_id: number
  source_filename: string
  original_stage_path: string
  ingest_status: string
}

/**
 * Coordinates of one photo in the link, or null when it is not part of the link. The
 * caller must already have checked that the link shares location.
 */
export function readPublicPhotoLocation(
  link: PublicLink,
  photoId: number,
): Promise<{ latitude: number; longitude: number } | null> {
  return pgQueryOne<{ latitude: number; longitude: number }>(
    `SELECT latitude,longitude FROM photos WHERE photo_id=$1 AND event_id=$2${selectedPhotos(3)}`,
    [photoId, link.event_id, publicSelection(link)],
  )
}

/**
 * The link's photos in capture order starting at `offset`. Returns up to 61 rows: one
 * more than a page, so the caller can tell whether a next page exists.
 */
export function listPublicPhotos(link: PublicLink, offset: number): Promise<PublicPhotoListing[]> {
  return pgQuery<PublicPhotoListing>(
    `SELECT photo_id,source_filename,media_type FROM photos WHERE event_id=$1${selectedPhotos(3)} ORDER BY date_taken NULLS LAST,photo_id LIMIT 61 OFFSET $2`,
    [link.event_id, offset, publicSelection(link)],
  )
}

/**
 * Storage paths and media type of one photo in the link, or null when it is not part of
 * the link. Includes the original path: the caller enforces the link's download policy.
 */
export function readPublicPhotoMedia(
  link: PublicLink,
  photoId: number,
): Promise<PublicPhotoMedia | null> {
  return pgQueryOne<PublicPhotoMedia>(
    `SELECT thumbnail_stage_path,display_stage_path,original_stage_path,media_type FROM photos WHERE photo_id=$1 AND event_id=$2${selectedPhotos(3)}`,
    [photoId, link.event_id, publicSelection(link)],
  )
}

/**
 * Thumbnail paths of ready photos in the link's album among the requested IDs. Does not
 * apply the link's selection: the caller must filter the rows by the link's `photo_ids`.
 */
export function listPublicAlbumThumbnails(
  eventId: number,
  photoIds: number[],
): Promise<{ photo_id: number; thumbnail_stage_path: string }[]> {
  return pgQuery<{ photo_id: number; thumbnail_stage_path: string }>(
    `SELECT photo_id,thumbnail_stage_path FROM photos WHERE event_id=$1 AND photo_id=ANY($2::int[]) AND ingest_status='READY'`,
    [eventId, photoIds],
  )
}

/**
 * Every photo and video in the link in capture order, unpaginated, including files that
 * are not ready. The caller must already have checked that the link allows downloads.
 */
export function listPublicDownloadPhotos(link: PublicLink): Promise<PublicDownloadPhoto[]> {
  return pgQuery<PublicDownloadPhoto>(
    `SELECT photo_id,source_filename,original_stage_path,ingest_status FROM photos WHERE event_id=$1${selectedPhotos(2)} ORDER BY date_taken NULLS LAST,photo_id`,
    [link.event_id, publicSelection(link)],
  )
}

/**
 * The original path of one photo if, right now, it is in the link's album and selection and
 * is ready; otherwise null. Used to re-authorize each file of a ZIP while it streams. `link`
 * must be a fresh `publicAlbum` result whose download policy the caller has just checked.
 */
export async function readPublicDownloadPath(
  link: PublicLink,
  photoId: number,
): Promise<string | null> {
  const row = await pgQueryOne<{ original_stage_path: string }>(
    `SELECT original_stage_path FROM photos WHERE photo_id=$1 AND event_id=$2${selectedPhotos(3)} AND ingest_status='READY' AND original_stage_path IS NOT NULL`,
    [photoId, link.event_id, publicSelection(link)],
  )
  return row?.original_stage_path ?? null
}
