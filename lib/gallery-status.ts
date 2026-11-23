import { pgQuery } from './postgres'

/**
 * Up to 50 ready photos whose AI description exhausted its attempts, for the projected
 * statistics view. Row security limits the rows to albums the caller can read.
 */
export function listExhaustedAiPhotos(): Promise<Record<string, unknown>[]> {
  return pgQuery(
    `SELECT photo_id,source_filename,ai_error FROM photos
         WHERE ingest_status='READY' AND media_type='photo' AND ai_description IS NULL
           AND ai_claim IS NULL AND ai_attempts>=3 ORDER BY photo_id LIMIT 50`,
  )
}
