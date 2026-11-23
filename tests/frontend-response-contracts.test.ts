import { expect, it } from 'vitest'
import {
  isAdminCostData,
  isAlbumSearchPage,
  isAllowances,
  isAnalysisStart,
  isLocationStatus,
  isPhotoSearchPage,
  isPlaces,
  isReviewPhotos,
  isTrashPage,
} from '@/lib/frontend-response-contracts'

const photo = {
  photoId: 1,
  eventId: 2,
  sourceFilename: 'photo.jpg',
  thumbnailUrl: null,
  aiDescription: null,
  caption: null,
}
const album = {
  eventId: 2,
  eventName: 'Album',
  eventMonth: null,
  eventYear: null,
  location: null,
  photoCount: 1,
  coverUrl: null,
}
const search = {
  results: [photo],
  source: 'people',
  count: 1,
  people: [{ personId: 'person', name: 'Name' }],
  suggestions: [{ personId: 'person', name: 'Name', coverFaceId: null, photoCount: 1 }],
  interpretation: { elapsedMs: 100, inputTokens: null, outputTokens: null },
  nextCursor: null,
}
const costs = {
  storage: { active_bytes: '1234', trash_bytes: '0', media_count: 1 },
  snapshots: [
    {
      day: '2026-11-21T00:00:00.000Z',
      active_bytes: '1234',
      trash_bytes: '0',
      sampled_at: '2026-11-21T10:00:00.000Z',
    },
  ],
  report: {
    refreshed_at: '2026-11-21T10:00:00.000Z',
    payload: {
      sections: [
        {
          key: 'compute',
          label: 'Compute',
          rows: [{ DATE: '2026-11-21', CREDITS: 0.5, EXTRA: null }],
          error: null,
        },
      ],
    },
  },
}
it('accepts endpoint-shaped empty, nullable, and populated search pages', () => {
  expect(isPhotoSearchPage(search)).toBe(true)
  expect(isPhotoSearchPage({ ...search, results: [], interpretation: null })).toBe(true)
  expect(isAlbumSearchPage({ ...search, results: [album] })).toBe(true)
  expect(isAlbumSearchPage(search)).toBe(false)
  expect(isPhotoSearchPage({ ...search, results: [album] })).toBe(false)
})
it('validates fields consumed by rendering rather than trusting HTTP 200', () => {
  for (const validate of [
    isPhotoSearchPage,
    isAlbumSearchPage,
    isTrashPage,
    isLocationStatus,
    isAllowances,
    isAdminCostData,
    isPlaces,
    isAnalysisStart,
  ]) {
    for (const bad of [{}, null, [], { error: 'Oops' }])
      expect(validate(bad), validate.name).toBe(false)
  }
  expect(isPhotoSearchPage({ ...search, people: [null] })).toBe(false)
  expect(isPhotoSearchPage({ ...search, results: [{ ...photo, photoId: '1' }] })).toBe(false)
  expect(
    isAdminCostData({ ...costs, report: { payload: { sections: [{}] }, refreshed_at: null } }),
  ).toBe(false)
})
it('accepts actual Postgres serialized cost numeric strings and report nulls', () => {
  expect(isAdminCostData(costs)).toBe(true)
  expect(isAdminCostData({ ...costs, snapshots: [], report: null })).toBe(true)
})
it('accepts concrete trash, location, allowance, review and analysis responses', () => {
  expect(
    isTrashPage({
      files: [{ photoId: 1, filename: 'x.jpg', albumName: 'Album', expiresAt: '2026-12-01' }],
      hasMore: false,
    }),
  ).toBe(true)
  expect(
    isLocationStatus({
      eligible: 0,
      changes: [
        { id: 'uuid', label: 'Paris', applied_by: 'user', applied_at: '2026-11-21', count: 1 },
      ],
    }),
  ).toBe(true)
  expect(isAllowances({ uploads: 0, bytes: 1073741824 })).toBe(true)
  expect(
    isPlaces({
      places: [{ label: 'Paris', lat: 48, lng: 2, city: 'Paris', region: null, country: 'France' }],
    }),
  ).toBe(true)
  expect(
    isReviewPhotos([
      { photoId: 1, sourceFilename: 'x.jpg', dateTaken: null, latitude: null, longitude: null },
    ]),
  ).toBe(true)
  expect(isReviewPhotos([{ photoId: 1, sourceFilename: 'x.jpg' }])).toBe(false)
  expect(isAnalysisStart({ id: 'uuid', status: 'queued' })).toBe(true)
})
