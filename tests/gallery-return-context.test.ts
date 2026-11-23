import { expect, it } from 'vitest'
import { galleryPhotoContext, galleryReturnPath, galleryViewerContext } from '@/lib/gallery-query'

it('keeps favorites origin across adjacent photos in different albums despite stale parents', () => {
  const context = galleryViewerContext('sort=name&media=photo', true)
  expect(galleryReturnPath(1, context, '/favorites?sort=name&media=photo')).toBe(
    '/favorites?sort=name&media=photo',
  )
  expect(galleryReturnPath(2, context, '/events/2?sort=newest')).toBe(
    '/favorites?sort=name&media=photo',
  )
  expect(galleryReturnPath(3, context, '/search?q=Paris')).toBe('/favorites?sort=name&media=photo')
})
it('explicit album context overrides an older search or People parent', () => {
  const context = galleryViewerContext('sort=uploaded&favorite=true', false)
  expect(galleryReturnPath(7, context, '/search?q=old')).toBe(
    '/events/7?sort=uploaded&favorite=true',
  )
  expect(galleryReturnPath(7, context, '/people/person')).toBe(
    '/events/7?sort=uploaded&favorite=true',
  )
})
it('People and search links retain their parent when they have no explicit gallery context', () => {
  const context = galleryPhotoContext({ face: '123', info: 'open' })
  expect(context).toBe('')
  for (const parent of ['/people/123', '/search?q=Paris'])
    expect(galleryReturnPath(7, context, parent)).toBe(parent)
  expect(galleryReturnPath(7, context)).toBe('/events/7')
})
it('page context preserves known origins and filters without inventing an album origin', () => {
  expect(galleryPhotoContext({ context: 'favorites', sort: 'newest', cursor: 'private' })).toBe(
    'sort=newest&context=favorites',
  )
  expect(galleryPhotoContext(new URLSearchParams('context=album&media=video&face=2'))).toBe(
    'media=video&context=album',
  )
  expect(galleryPhotoContext({ context: 'unknown', sort: 'name' })).toBe('sort=name')
})
it('return navigation while a photo is unavailable never generates an undefined album URL', () => {
  expect(galleryReturnPath(undefined, 'context=album&sort=newest')).toBe('/')
  expect(galleryReturnPath(undefined, 'context=favorites&media=photo')).toBe(
    '/favorites?media=photo',
  )
  expect(galleryReturnPath(undefined, '', '/search?q=Paris')).toBe('/search?q=Paris')
  for (const id of [NaN, 0, -1, 1.2]) expect(galleryReturnPath(id, 'context=album')).toBe('/')
})
