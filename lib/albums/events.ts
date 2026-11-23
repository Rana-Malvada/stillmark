import { HttpError, integer, textValue } from '@/lib/http'
import { pgQuery, pgQueryOne, pgTransaction } from '@/lib/postgres'
import { lockManagement } from '../database/management-lock'

export interface AppEvent {
  ownerDisplayName?: string | null
  archivedAccount?: boolean
  eventId: number
  ownerUsername: string
  sortOrder: number
  eventName: string
  sourceFolder: string
  eventMonth: number | null
  eventYear: number | null
  coverPhotoId: number | null
  photoCount: number
  visibility: string
  coverThumbnailPath: string | null
  location: string | null
  folderId: number | null
}

export function mapEvent(r: Record<string, unknown>): AppEvent {
  return {
    ownerDisplayName: r.owner_display_name ? String(r.owner_display_name) : null,
    archivedAccount: r.archived_account === true,
    eventId: Number(r.event_id),
    ownerUsername: String(r.owner_username),
    sortOrder: Number(r.sort_order),
    eventName: String(r.event_name),
    sourceFolder: String(r.source_folder),
    eventMonth: r.event_month != null ? Number(r.event_month) : null,
    eventYear: r.event_year != null ? Number(r.event_year) : null,
    coverPhotoId: r.cover_photo_id != null ? Number(r.cover_photo_id) : null,
    photoCount: Number(r.photo_count ?? 0),
    visibility: String(r.visibility ?? 'PRIVATE'),
    coverThumbnailPath: r.thumbnail_stage_path ? String(r.thumbnail_stage_path) : null,
    location: r.location ? String(r.location) : null,
    folderId: r.folder_id != null ? Number(r.folder_id) : null,
  }
}

export async function getEvent(eventId: number): Promise<AppEvent | null> {
  const r = await pgQueryOne(
    `SELECT e.*, p.thumbnail_stage_path
     FROM events e
     LEFT JOIN photos p ON e.cover_photo_id = p.photo_id
     WHERE e.event_id = $1`,
    [eventId],
  )
  return r ? mapEvent(r) : null
}

/** Upload validation needs the folder, not the album's cover-photo join. */
export async function getUploadEvent(eventId: number): Promise<{ folderId: number | null } | null> {
  return pgQueryOne<{ folderId: number | null }>(
    'SELECT folder_id AS "folderId" FROM events WHERE event_id=$1',
    [eventId],
  )
}

export async function deleteEvent(eventId: number): Promise<void> {
  await pgTransaction(async () => {
    await lockManagement()
    await pgQuery('SELECT pg_advisory_xact_lock($1)', [eventId])
    await pgQuery(
      `INSERT INTO photo_trash(photo_id,photo_data,album_name)
      SELECT p.photo_id,to_jsonb(p),e.event_name FROM photos p JOIN events e ON e.event_id=p.event_id WHERE p.event_id=$1`,
      [eventId],
    )
    await pgQuery(
      'DELETE FROM upload_files WHERE upload_job_id IN (SELECT upload_job_id FROM upload_jobs WHERE event_id = $1)',
      [eventId],
    )
    await pgQuery('DELETE FROM upload_jobs WHERE event_id = $1', [eventId])
    await pgQuery('DELETE FROM photos WHERE event_id = $1', [eventId])
    await pgQuery('DELETE FROM events WHERE event_id = $1', [eventId])
  })
}

export async function updateAlbumDetails(
  eventId: number,
  updates: {
    sortOrder?: number
    eventName?: string
    location?: string | null
    eventMonth?: number | null
    eventYear?: number | null
    folderId?: number | null
  },
): Promise<void> {
  const sets: string[] = []
  const vals: unknown[] = []
  let idx = 1

  if (updates.sortOrder !== undefined) {
    sets.push(`sort_order = $${idx++}`)
    vals.push(integer(updates.sortOrder, 'sortOrder', 0))
  }
  if (updates.eventName !== undefined) {
    sets.push(`event_name = $${idx++}`)
    vals.push(textValue(updates.eventName, 'eventName'))
  }
  if (updates.location !== undefined) {
    sets.push(`location = $${idx++}`)
    vals.push(updates.location === null ? null : textValue(updates.location, 'location'))
  }
  if (updates.eventMonth !== undefined) {
    sets.push(`event_month = $${idx++}`)
    vals.push(updates.eventMonth === null ? null : integer(updates.eventMonth, 'eventMonth', 1, 12))
  }
  if (updates.eventYear !== undefined) {
    sets.push(`event_year = $${idx++}`)
    vals.push(updates.eventYear === null ? null : integer(updates.eventYear, 'eventYear', 1, 9999))
  }
  if (updates.folderId !== undefined) {
    sets.push(`folder_id = $${idx++}`)
    vals.push(updates.folderId === null ? null : integer(updates.folderId, 'folderId'))
  }

  if (sets.length === 0) return
  sets.push(`updated_at = NOW()`)
  vals.push(eventId)
  await pgQuery(`UPDATE events SET ${sets.join(', ')} WHERE event_id = $${idx}`, vals)
}

export async function createEvent(event: {
  ownerUsername: string
  sortOrder: number
  eventName: string
  sourceFolder: string
  eventMonth: number | null
  eventYear: number | null
  location: string | null
  folderId?: number | null
}): Promise<number> {
  const r = await pgQueryOne<{ event_id: number }>(
    `INSERT INTO events (sort_order, event_name, source_folder, event_month, event_year, location, folder_id, owner_username,visibility)
     VALUES ($1, $2, $3, $4, $5, $6, $7,$8,'PRIVATE')
     ON CONFLICT (source_folder) DO UPDATE SET updated_at = NOW() WHERE events.owner_username=EXCLUDED.owner_username
     RETURNING event_id`,
    [
      event.sortOrder,
      event.eventName,
      event.sourceFolder,
      event.eventMonth,
      event.eventYear,
      event.location,
      event.folderId ?? null,
      event.ownerUsername,
    ],
  )
  if (!r) throw new HttpError(409, 'An album with this source already belongs to another user')
  return r.event_id
}

// Publication already holds the album advisory lock. Verify the newly inserted
// row is READY; NULL media_type is still counted, matching full reconciliation.
// A legacy NULL counter needs a full baseline including this row, not baseline+1.
export const publishedPhotoCountSql = `UPDATE events e
 SET photo_count = CASE WHEN e.photo_count IS NULL THEN
   (SELECT COUNT(*) FROM photos WHERE event_id=$1 AND ingest_status='READY')
   ELSE e.photo_count+1 END,
 updated_at=NOW()
 WHERE e.event_id=$1 AND EXISTS (
   SELECT 1 FROM photos p WHERE p.photo_id=$2 AND p.event_id=e.event_id AND p.ingest_status='READY'
 )`

/**
 * With newPhotoId, apply one successful publication inside its locked transaction.
 * Never pass an existing duplicate/replay ID. Without it, reconcile from source rows.
 */
export async function updateEventPhotoCount(eventId: number, newPhotoId?: number): Promise<void> {
  if (newPhotoId !== undefined) {
    await pgQuery(publishedPhotoCountSql, [eventId, newPhotoId])
    return
  }
  await pgQuery(
    `UPDATE events
     SET photo_count = (SELECT COUNT(*) FROM photos WHERE event_id = $1 AND ingest_status = 'READY'),
         updated_at = NOW()
     WHERE event_id = $1`,
    [eventId],
  )
}

export async function setCoverPhoto(eventId: number, photoId: number): Promise<void> {
  await pgQuery(
    `UPDATE events SET cover_photo_id = $1, updated_at = NOW() WHERE event_id = $2 AND cover_photo_id IS NULL`,
    [photoId, eventId],
  )
}

export async function findEventBySourceFolder(sourceFolder: string): Promise<AppEvent | null> {
  const r = await pgQueryOne(
    `SELECT e.*, NULL AS thumbnail_stage_path
     FROM events e WHERE e.source_folder = $1`,
    [sourceFolder],
  )
  return r ? mapEvent(r) : null
}

/** Explicit cover selection; uploads only fill an empty cover. */
export async function chooseCoverPhoto(photoId: number): Promise<boolean> {
  return pgTransaction(async () => {
    const photo = await pgQueryOne<{ event_id: number }>(
      'SELECT event_id FROM photos WHERE photo_id=$1',
      [photoId],
    )
    if (!photo) return false
    await pgQuery('SELECT pg_advisory_xact_lock($1)', [photo.event_id])
    const rows = await pgQuery(
      `UPDATE events SET cover_photo_id=$1, updated_at=NOW()
      WHERE event_id=$2 AND EXISTS (SELECT 1 FROM photos WHERE photo_id=$1 AND event_id=$2 AND ingest_status='READY' AND thumbnail_stage_path IS NOT NULL)
      RETURNING event_id`,
      [photoId, photo.event_id],
    )
    return rows.length > 0
  })
}
