import { describe, expect, it } from 'vitest'
import { isGalleryStatus } from '../lib/gallery-status-contract'

const status = {
  total_photos: 10,
  total_videos: 0,
  photos_with_ai: 9,
  photos_without_ai: 0,
  photos_failed: 1,
  in_search: 9,
  pending_sync: 1,
  pending_search_removals: 0,
  failed_photos: [{ photo_id: '7', source_filename: 'test.jpg', ai_error: null }],
}
describe('gallery status wire contract', () => {
  it('accepts both query paths, nullable stored errors and precision-preserving counters', () => {
    expect(isGalleryStatus(status)).toBe(true)
    expect(isGalleryStatus({ ...status, total_photos: '9007199254740993' })).toBe(true)
    const { pending_search_removals: _, ...legacy } = status
    expect(isGalleryStatus(legacy)).toBe(true)
  })
  it.each([
    null,
    {},
    { ...status, failed_photos: null },
    { ...status, pending_sync: -1 },
    { ...status, total_photos: 1.5 },
    { ...status, total_photos: 'unknown' },
    { ...status, failed_photos: [{ photo_id: 'unsafe', source_filename: 'test.jpg' }] },
    {
      ...status,
      failed_photos: [
        { photo_id: '9007199254740993', source_filename: 'test.jpg', ai_error: null },
      ],
    },
  ])('rejects incomplete or invalid data before render', (value) => {
    expect(isGalleryStatus(value)).toBe(false)
  })
})
