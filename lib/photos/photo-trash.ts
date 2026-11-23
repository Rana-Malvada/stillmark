import type { AlbumCaller } from '../albums/album-access'
import { pgQuery, pgQueryOne } from '../postgres'

/** Trash visibility: the main admin sees every entry, other callers only their own. */
type TrashCaller = Pick<AlbumCaller, 'mainAdmin' | 'username'>

/**
 * Unexpired Trash entries visible to the caller, newest first, starting at `offset`.
 * Returns up to 101 rows: one more than a page, so the caller can tell whether more exist.
 */
export function listTrashPage(
  offset: number,
  caller: TrashCaller,
): Promise<Record<string, unknown>[]> {
  return pgQuery(
    `SELECT photo_id AS "photoId",photo_data->>'source_filename' AS filename,album_name AS "albumName",
   deleted_at AS "deletedAt",expires_at AS "expiresAt" FROM photo_trash WHERE expires_at>NOW() AND ($2::boolean OR owner_username=$3) ORDER BY deleted_at DESC,photo_id DESC LIMIT 101 OFFSET $1`,
    [offset, caller.mainAdmin, caller.username],
  )
}

/**
 * Distinct albums the given Trash entries were deleted from. Applies no visibility rule:
 * the caller must already have checked Trash access to these photos.
 */
export async function trashedPhotoAlbumIds(photoIds: number[]): Promise<number[]> {
  const rows = await pgQuery<{ event_id: number }>(
    "SELECT DISTINCT (photo_data->>'event_id')::int AS event_id FROM photo_trash WHERE photo_id=ANY($1::int[])",
    [photoIds],
  )
  return rows.map((r) => r.event_id)
}

/** IDs of every Trash entry the caller may manage, including expired ones. */
export async function listTrashPhotoIds(caller: TrashCaller): Promise<number[]> {
  const rows = await pgQuery<{ photo_id: number }>(
    'SELECT photo_id FROM photo_trash WHERE $1::boolean OR owner_username=$2',
    [caller.mainAdmin, caller.username],
  )
  return rows.map((r) => r.photo_id)
}

/**
 * Stored thumbnail path of one unexpired Trash entry visible to the caller, or null.
 * Follows Trash visibility, never normal album visibility.
 */
export async function readTrashThumbnailPath(
  photoId: number,
  caller: TrashCaller,
): Promise<string | null> {
  const row = await pgQueryOne<{ path: string | null }>(
    `SELECT photo_data->>'thumbnail_stage_path' AS path FROM photo_trash WHERE photo_id=$1 AND expires_at>NOW() AND ($2::boolean OR owner_username=$3)`,
    [photoId, caller.mainAdmin, caller.username],
  )
  return row?.path || null
}

/**
 * Stored thumbnail paths of the unexpired Trash entries visible to the caller. Entries the
 * caller cannot see are absent; the paths are not validated.
 */
export function listTrashThumbnailPaths(
  photoIds: number[],
  caller: TrashCaller,
): Promise<{ photo_id: number; path: string | null }[]> {
  return pgQuery<{ photo_id: number; path: string | null }>(
    `SELECT photo_id,photo_data->>'thumbnail_stage_path' AS path FROM photo_trash WHERE photo_id=ANY($1::int[]) AND expires_at>NOW() AND ($2::boolean OR owner_username=$3)`,
    [photoIds, caller.mainAdmin, caller.username],
  )
}
