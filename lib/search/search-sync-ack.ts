/** Claim before reading photos or submitting remote writes. Deletion locks the
 * same queue row, so it can cancel only work no publisher has picked up. */
export const claimPhotosSql = `UPDATE search_queue q SET publication_attempted=true
 FROM (SELECT id FROM search_queue WHERE kind='photo' ORDER BY queued_at,id LIMIT 200) picked
 WHERE q.kind='photo' AND q.id=picked.id
 RETURNING q.id,q.revision`

/** One statement atomically acknowledges only the revisions actually published.
 * A concurrent edit either wins first and stays queued, or requeues after this
 * statement. Updating the timestamp is bookkeeping, not a new search edit. */
export const acknowledgePhotosSql = `WITH acknowledged AS (
 DELETE FROM search_queue q USING unnest($1::int[], $2::bigint[]) AS sent(id,revision)
 WHERE q.kind='photo' AND q.id=sent.id AND q.revision=sent.revision RETURNING q.id
) UPDATE photos SET search_synced_at=CASE WHEN photo_id=ANY($3::int[]) THEN NOW() ELSE NULL END WHERE photo_id IN (SELECT id FROM acknowledged)`
export const acknowledgeEventsSql = `DELETE FROM search_queue q
 USING unnest($1::int[], $2::bigint[]) AS sent(id,revision)
 WHERE q.kind='event' AND q.id=sent.id AND q.revision=sent.revision`
