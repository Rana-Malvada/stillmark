import { pgIndependent } from '../postgres'

/** Keep active recovery receipts and all uncertain/unsettled outcomes indefinitely.
 * Only old received, billed attempts that are retired or orphaned are disposable. */
export async function prunePhotoInferenceReceipts() {
  const days = Number(process.env.PHOTO_AI_RECEIPT_RETENTION_DAYS ?? 90)
  if (!Number.isSafeInteger(days) || (days !== 0 && (days < 30 || days > 3650)))
    throw new Error('Invalid PHOTO_AI_RECEIPT_RETENTION_DAYS')
  if (days === 0) return 0
  const [row] = await pgIndependent<{ removed: number }>(
    'SELECT photo_security.prune_photo_inference_receipts($1::int) AS removed',
    [days],
  )
  return row.removed
}
