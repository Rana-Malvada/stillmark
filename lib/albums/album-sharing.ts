import { pgQuery, pgQueryOne } from '../postgres'

export type AlbumVisibility = 'PRIVATE' | 'GALLERY'

/**
 * Usernames an album is shared with, in name order. The caller must already have
 * checked that the requester may see the share list.
 */
export function listAlbumShares(eventId: number): Promise<{ username: string }[]> {
  return pgQuery<{ username: string }>(
    'SELECT username FROM album_shares WHERE event_id=$1 ORDER BY username',
    [eventId],
  )
}

/** Sets an album's visibility. Call inside `albumMutation` after a write-access check. */
export async function setAlbumVisibility(
  eventId: number,
  visibility: AlbumVisibility,
): Promise<void> {
  await pgQuery('UPDATE events SET visibility=$2,updated_at=now() WHERE event_id=$1', [
    eventId,
    visibility,
  ])
}

/** Removes one user's share. Call inside `albumMutation` after a write-access check. */
export async function revokeAlbumShare(eventId: number, username: string): Promise<void> {
  await pgQuery('DELETE FROM album_shares WHERE event_id=$1 AND username=$2', [eventId, username])
}

/** Whether the username belongs to an active gallery account that can receive access. */
export async function isActiveGalleryUsername(username: string): Promise<boolean> {
  const row = await pgQueryOne<{ allowed: boolean }>(
    'SELECT photo_security.active_username($1) AS allowed',
    [username],
  )
  return !!row?.allowed
}

/**
 * Shares an album with a user; an existing share is left as it is. Call inside
 * `albumMutation` after a write-access check and after confirming the username is active.
 */
export async function addAlbumShare(
  eventId: number,
  username: string,
  createdBy: string,
): Promise<void> {
  await pgQuery(
    'INSERT INTO album_shares(event_id,username,created_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [eventId, username, createdBy],
  )
}

/**
 * Moves an album and its Trash entries to a new owner, detaching the album from a folder
 * the new owner cannot use. Call inside `albumMutation`; the caller must already have
 * confirmed main-admin permission and that the username is active.
 */
export async function transferAlbumOwnership(eventId: number, username: string): Promise<void> {
  await pgQuery(
    `UPDATE events
     SET owner_username=$2,
       folder_id=CASE WHEN EXISTS(
         SELECT 1 FROM folders f
         WHERE f.folder_id=events.folder_id AND (f.owner_username IS NULL OR f.owner_username=$2)
       ) THEN folder_id ELSE NULL END,
       updated_at=now()
     WHERE event_id=$1`,
    [eventId, username],
  )
  await pgQuery(
    "UPDATE photo_trash SET owner_username=$2 WHERE (photo_data->>'event_id')::int=$1",
    [eventId, username],
  )
}
