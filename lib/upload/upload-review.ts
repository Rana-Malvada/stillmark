import type { FileProgress } from '@/lib/upload/upload-response'

export interface ReviewPhoto {
  photoId: number
  sourceFilename: string
  dateTaken: string | null
  latitude: number | null
  longitude: number | null
}
export function uploadReview(files: FileProgress[], photos: ReviewPhoto[]) {
  const ids = new Set(
    files
      .filter((f) => f.phase === 'success' || f.phase === 'skipped')
      .map((f) => f.photoId)
      .filter((id): id is number => id != null),
  )
  const uploaded = photos.filter((p) => ids.has(p.photoId))
  return {
    missingDates: uploaded.filter((p) => !p.dateTaken),
    missingGps: uploaded.filter((p) => p.latitude == null || p.longitude == null),
    duplicates: files.filter(
      (f) => f.phase === 'skipped' && f.skipReason !== 'metadata' && f.photoId != null,
    ),
    failed: files.filter((f) => f.phase === 'failed'),
    checked: uploaded.length,
  }
}
