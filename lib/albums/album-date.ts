import { albumMutation, requireAlbumAccess } from './album-access'
import { pgQueryOne } from '../postgres'
import { HttpError } from '../http'

export async function applyAlbumDate(eventId: number, date: unknown, scope: unknown) {
  if (
    typeof date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    date.startsWith('0000') ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw new HttpError(400, 'Enter a valid calendar date')
  if (scope !== 'all' && scope !== 'missing')
    throw new HttpError(400, 'Choose which photos to update')
  return albumMutation(
    async (caller) => {
      await requireAlbumAccess(eventId, true, caller)
      // UTC matches the individual capture-date editor. Preserve each existing time of day.
      const result = await pgQueryOne<{ count: number }>(
        `WITH changed AS (
        UPDATE photos SET date_taken=($2::date + COALESCE((date_taken AT TIME ZONE 'UTC')::time, TIME '00:00:00')) AT TIME ZONE 'UTC', updated_at=NOW()
        WHERE event_id=$1 AND ingest_status='READY' AND media_type='photo'
          AND ($3::text='all' OR date_taken IS NULL)
        RETURNING photo_id
      ) SELECT count(*)::int AS count FROM changed`,
        [eventId, date, scope],
      )
      return { count: result?.count ?? 0 }
    },
    { eventIds: [eventId] },
  )
}
