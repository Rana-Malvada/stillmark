import { processAllUncategorized } from '../ai-categorize'
import { pgQuery } from '../postgres'

/**
 * Makes one photo eligible for AI description again; the database function owns the retry
 * rules. The caller must require the main admin and drain the queue afterwards.
 */
export async function retryPhotoInference(photoId: number): Promise<void> {
  await pgQuery('SELECT photo_security.retry_photo_inference($1)', [photoId])
}

let running: Promise<void> | undefined
let requested = false

/** Wake on upload; drain bounded batches without waiting for unrelated cleanup.
 * Legacy batches retain their cross-instance lock. Opt-in leased admission
 * bounds fleet/tenant claims in short transactions. Idle or quota-blocked
 * batches stop rather than spin; the scheduled wake retries them later.
 */
export function drainPhotoAiQueue(): Promise<void> {
  requested = true
  if (running) return running
  running = Promise.resolve()
    .then(async () => {
      while (requested) {
        requested = false
        const batch = await processAllUncategorized()
        if (batch.processed > 0 || batch.errors.length > 0) requested = true
      }
    })
    .catch((error) => {
      // Database/provider outages wait for the next scheduled wake, not a hot loop.
      requested = false
      throw error
    })
    .finally(() => {
      running = undefined
      // An upload may arrive after the empty batch resolves but before this cleanup.
      if (requested) return drainPhotoAiQueue()
    })
  return running
}
