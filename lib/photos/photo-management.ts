import { withServiceDatabase } from '../database/database-context'
import { pgQuery, pgQueryOne, pgTransaction } from '@/lib/postgres'
import { HttpError, integer } from '@/lib/http'
import { lockManagement } from '../database/management-lock'

export function photoIds(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.length > 200)
    throw new HttpError(400, 'Select between 1 and 200 files')
  return [...new Set(value.map((id) => integer(id, 'photoId')))].sort((a, b) => a - b)
}
/** Recount each album and replace a cover that is no longer one of its ready photos. */
async function repairAlbums(ids: number[]) {
  await pgQuery(
    `UPDATE events e
     SET photo_count = (
           SELECT COUNT(*) FROM photos WHERE event_id = e.event_id AND ingest_status = 'READY'
         ),
         cover_photo_id = CASE
           WHEN EXISTS (
             SELECT 1 FROM photos
             WHERE photo_id = e.cover_photo_id AND event_id = e.event_id AND ingest_status = 'READY'
           ) THEN e.cover_photo_id
           ELSE (
             SELECT photo_id FROM photos
             WHERE event_id = e.event_id AND ingest_status = 'READY'
               AND thumbnail_stage_path IS NOT NULL
             ORDER BY photo_id LIMIT 1
           )
         END,
         updated_at = NOW()
     WHERE event_id = ANY($1::int[])`,
    [ids],
  )
}

/** Queue the stored files of trashed photos for durable, retried deletion. */
async function queueTrashCleanup(ids: number[]) {
  await pgQuery(
    `INSERT INTO stage_cleanup(path, next_attempt)
     SELECT DISTINCT v.path, NOW()
     FROM photo_trash t
     CROSS JOIN LATERAL (VALUES
       (t.photo_data->>'original_stage_path'),
       (t.photo_data->>'display_stage_path'),
       (t.photo_data->>'thumbnail_stage_path')
     ) v(path)
     WHERE t.photo_id = ANY($1::int[]) AND v.path IS NOT NULL
     ON CONFLICT(path) DO UPDATE SET next_attempt = NOW(), attempts = 0, last_error = NULL`,
    [ids],
  )
}

export async function bulkPhotos(ids: number[], action: string, destination?: number) {
  return pgTransaction(async () => {
    await lockManagement()
    const photos = await pgQuery<{ photo_id: number; event_id: number }>(
      'SELECT photo_id,event_id FROM photos WHERE photo_id=ANY($1::int[]) ORDER BY photo_id',
      [ids],
    )
    if (photos.length !== ids.length)
      throw new HttpError(
        409,
        'Some selected files are no longer available; refresh and select again',
      )
    const albums = [
      ...new Set([...photos.map((p) => p.event_id), ...(destination ? [destination] : [])]),
    ].sort((a, b) => a - b)
    for (const id of albums) await pgQuery('SELECT pg_advisory_xact_lock($1)', [id])
    if (action === 'trash') {
      // Set-based: two statements for the whole selection instead of several per photo.
      await pgQuery(
        `INSERT INTO photo_trash(photo_id, photo_data, album_name)
         SELECT p.photo_id, to_jsonb(p), e.event_name
         FROM photos p JOIN events e ON e.event_id = p.event_id
         WHERE p.photo_id = ANY($1::int[])`,
        [ids],
      )
      await pgQuery('DELETE FROM photos WHERE photo_id = ANY($1::int[])', [ids])
      await repairAlbums(albums)
    } else if (action === 'favorite' || action === 'unfavorite') {
      await pgQuery(
        'UPDATE photos SET favorite=$2,updated_at=NOW() WHERE photo_id=ANY($1::int[])',
        [ids, action === 'favorite'],
      )
    } else if (action === 'move') {
      if (
        !destination ||
        !(await pgQueryOne('SELECT event_id FROM events WHERE event_id=$1 FOR UPDATE', [
          destination,
        ]))
      )
        throw new HttpError(404, 'Destination album not found')
      try {
        await pgQuery(
          'UPDATE photos SET event_id=$2,updated_at=NOW() WHERE photo_id=ANY($1::int[])',
          [ids, destination],
        )
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw new HttpError(
            409,
            'The destination already contains an identical file. No files were moved.',
          )
        throw error
      }
      await repairAlbums(albums)
    } else throw new HttpError(400, 'Invalid bulk action')
    return { count: ids.length }
  })
}
export async function restorePhotos(ids: number[], destination?: number) {
  return pgTransaction(async () => {
    await lockManagement()
    const rows = await pgQuery<{ photo_id: number; photo_data: Record<string, unknown> }>(
      `SELECT photo_id,photo_data FROM photo_trash WHERE photo_id=ANY($1::int[]) AND expires_at>NOW() ORDER BY photo_id FOR UPDATE`,
      [ids],
    )
    if (rows.length !== ids.length)
      throw new HttpError(409, 'Some files have expired or were already restored; refresh Trash')
    const albums = [
      ...new Set(rows.map((row) => destination ?? Number(row.photo_data.event_id))),
    ].sort((a, b) => a - b)
    for (const id of albums) {
      await pgQuery('SELECT pg_advisory_xact_lock($1)', [id])
      if (!(await pgQueryOne('SELECT event_id FROM events WHERE event_id=$1 FOR UPDATE', [id])))
        throw new HttpError(409, 'An original album no longer exists. Choose a destination album.')
    }
    try {
      // One statement restores every selected row with its album, timestamp and
      // AI claim reset; a duplicate in any destination rolls the whole restore back.
      await pgQuery(
        `INSERT INTO photos
         SELECT (jsonb_populate_record(
           NULL::photos,
           t.photo_data || jsonb_build_object(
             'event_id', COALESCE($2::int, (t.photo_data->>'event_id')::int),
             'updated_at', NOW(),
             'ai_claim', NULL,
             'ai_lease_until', NULL
           )
         )).*
         FROM photo_trash t
         WHERE t.photo_id = ANY($1::int[])
         ORDER BY t.photo_id`,
        [ids, destination ?? null],
      )
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new HttpError(
          409,
          'An identical file already exists in the destination. Nothing was restored; originals remain in Trash.',
        )
      throw error
    }
    await pgQuery('DELETE FROM photo_trash WHERE photo_id=ANY($1::int[])', [ids])
    await repairAlbums(albums)
    return { count: ids.length }
  })
}
async function purgeExpiredTrashService() {
  await pgTransaction(async () => {
    await lockManagement()
    const rows = await pgQuery<{ photo_id: number }>(
      'SELECT photo_id FROM photo_trash WHERE expires_at<=NOW() ORDER BY expires_at LIMIT 100 FOR UPDATE',
    )
    const keys = rows.map((row) => row.photo_id)
    if (!keys.length) return
    await queueTrashCleanup(keys)
    await pgQuery('DELETE FROM photo_trash WHERE photo_id = ANY($1::int[])', [keys])
  })
}

/** Irreversible removal from Trash; physical storage cleanup is durable and retried. */
export async function permanentlyDeleteTrash(ids: number[] | null) {
  return pgTransaction(async () => {
    await lockManagement()
    const selected = await pgQuery<{ photo_id: number }>(
      'SELECT photo_id FROM photo_trash WHERE ($1::int[] IS NULL OR photo_id=ANY($1)) FOR UPDATE',
      [ids],
    )
    if (ids && selected.length !== ids.length)
      throw new HttpError(409, 'Some files are no longer in Trash; refresh and try again')
    const keys = selected.map((r) => r.photo_id)
    if (!keys.length) return { count: 0 }
    await queueTrashCleanup(keys)
    await pgQuery('DELETE FROM photo_trash WHERE photo_id=ANY($1::int[])', [keys])
    return { count: keys.length }
  })
}

export function purgeExpiredTrash(...args: Parameters<typeof purgeExpiredTrashService>) {
  return withServiceDatabase(() => purgeExpiredTrashService(...args))
}
