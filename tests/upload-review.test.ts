import { expect, it } from 'vitest'
import { uploadReview } from '@/lib/upload/upload-review'

it('reviews only saved batch photos, keeps zero coordinates, excludes sidecars from duplicates', () => {
  const r = uploadReview(
    [
      { filename: 'a', phase: 'success', percent: 100, photoId: 1 },
      { filename: 'copy', phase: 'skipped', percent: 100, photoId: 1 },
      { filename: 'meta', phase: 'skipped', skipReason: 'metadata', percent: 100 },
      { filename: 'bad', phase: 'failed', percent: 0, error: 'Timeout' },
    ],
    [
      { photoId: 1, sourceFilename: 'a', dateTaken: null, latitude: 0, longitude: 0 },
      { photoId: 2, sourceFilename: 'unrelated', dateTaken: null, latitude: null, longitude: null },
    ],
  )
  expect(r.checked).toBe(1)
  expect(r.missingDates).toHaveLength(1)
  expect(r.missingGps).toHaveLength(0)
  expect(r.duplicates).toHaveLength(1)
  expect(r.failed[0].error).toBe('Timeout')
})
it('flags partial coordinates and retains failed files before metadata loads', () => {
  expect(uploadReview([{ filename: 'bad', phase: 'failed', percent: 0 }], []).failed).toHaveLength(
    1,
  )
  const r = uploadReview(
    [{ filename: 'a', phase: 'success', percent: 100, photoId: 1 }],
    [{ photoId: 1, sourceFilename: 'a', dateTaken: '2026-01-01', latitude: 3, longitude: null }],
  )
  expect(r.missingGps).toHaveLength(1)
  expect(r.missingDates).toHaveLength(0)
})
