/** Counts may be decimal strings: PostgreSQL and very large counters preserve precision. */
export type GalleryCount = number | string
export interface GalleryStatus {
  total_photos: GalleryCount
  total_videos: GalleryCount
  photos_with_ai: GalleryCount
  photos_without_ai: GalleryCount
  photos_failed: GalleryCount
  in_search: GalleryCount
  pending_sync: GalleryCount
  pending_search_removals?: GalleryCount
  failed_photos: Array<{
    photo_id: number | string
    source_filename: string
    ai_error: string | null
  }>
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): boolean =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
  (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))

export function isGalleryStatus(value: unknown): value is GalleryStatus {
  return (
    record(value) &&
    [
      'total_photos',
      'total_videos',
      'photos_with_ai',
      'photos_without_ai',
      'photos_failed',
      'in_search',
      'pending_sync',
    ].every((key) => count(value[key])) &&
    (value.pending_search_removals === undefined || count(value.pending_search_removals)) &&
    Array.isArray(value.failed_photos) &&
    value.failed_photos.every(
      (row) =>
        record(row) &&
        count(row.photo_id) &&
        Number.isSafeInteger(Number(row.photo_id)) &&
        Number(row.photo_id) > 0 &&
        typeof row.source_filename === 'string' &&
        (row.ai_error === null || typeof row.ai_error === 'string'),
    )
  )
}
