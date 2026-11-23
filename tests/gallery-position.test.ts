import { afterEach, expect, it, vi } from 'vitest'
import { galleryParent, rememberGalleryPosition } from '@/components/gallery-position'

afterEach(() => vi.unstubAllGlobals())
it('remembers the source list independently for each user and album', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
  })
  vi.stubGlobal('location', { pathname: '/my-albums', search: '' })
  vi.stubGlobal('window', { scrollY: 1250 })
  rememberGalleryPosition('ALICE', 'album:12')
  expect(galleryParent('ALICE', 'album:12', '/')).toBe('/my-albums')
  expect(galleryParent('BOB', 'album:12', '/')).toBe('/')
  expect(galleryParent('ALICE', 'album:99', '/')).toBe('/')
  expect(JSON.parse(values.get('gallery-position-v1:ALICE:position:/my-albums')!)).toEqual({
    y: 1250,
  })
  values.set('gallery-position-v1:ALICE:parent:album:12', JSON.stringify('//evil.example'))
  expect(galleryParent('ALICE', 'album:12', '/')).toBe('/')
})
it('navigation still works when browser storage is unavailable', () => {
  vi.stubGlobal('sessionStorage', {
    getItem: () => {
      throw Error('blocked')
    },
    setItem: () => {
      throw Error('blocked')
    },
  })
  vi.stubGlobal('location', { pathname: '/', search: '' })
  vi.stubGlobal('window', { scrollY: 300 })
  expect(() => rememberGalleryPosition('ALICE', 'album:1')).not.toThrow()
  expect(galleryParent('ALICE', 'album:1', '/')).toBe('/')
})
it('retains full search query and mode for album and photo return paths', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
  })
  vi.stubGlobal('location', {
    pathname: '/search',
    search: '?q=Barcelona&type=albums&mode=semantic',
  })
  vi.stubGlobal('window', { scrollY: 900 })
  rememberGalleryPosition('ALICE', 'album:12')
  rememberGalleryPosition('ALICE', 'photo-grid:12')
  expect(galleryParent('ALICE', 'album:12', '/')).toBe(
    '/search?q=Barcelona&type=albums&mode=semantic',
  )
  expect(galleryParent('ALICE', 'photo-grid:12', '/events/12')).toBe(
    '/search?q=Barcelona&type=albums&mode=semantic',
  )
})
it('returns from a photo to the People page it was opened from, never a look-alike path', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
  })
  vi.stubGlobal('window', { scrollY: 0 })
  const person = '/people/22222222-2222-4222-8222-222222222222'
  vi.stubGlobal('location', { pathname: person, search: '' })
  rememberGalleryPosition('ALICE', 'photo-grid:7')
  expect(galleryParent('ALICE', 'photo-grid:7', '/events/7')).toBe(person)
  vi.stubGlobal('location', { pathname: '/people', search: '?tab=review' })
  rememberGalleryPosition('ALICE', 'photo-grid:7')
  expect(galleryParent('ALICE', 'photo-grid:7', '/events/7')).toBe('/people?tab=review')
  for (const bad of ['/people/../admin', '/people/x', '/peoplex', '/people//evil.example']) {
    values.set('gallery-position-v1:ALICE:parent:photo-grid:7', JSON.stringify(bad))
    expect(galleryParent('ALICE', 'photo-grid:7', '/events/7'), bad).toBe('/events/7')
  }
})

it('remembers the filtered People list and its scroll position for a person', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
  })
  vi.stubGlobal('location', { pathname: '/people', search: '?tab=people&filter=hidden' })
  vi.stubGlobal('window', { scrollY: 1400 })
  rememberGalleryPosition('ALICE', 'person:22222222-2222-4222-8222-222222222222')
  expect(galleryParent('ALICE', 'person:22222222-2222-4222-8222-222222222222', '/people')).toBe(
    '/people?tab=people&filter=hidden',
  )
  expect(
    JSON.parse(values.get('gallery-position-v1:ALICE:position:/people?tab=people&filter=hidden')!),
  ).toEqual({ y: 1400 })
})

it('only restores an album for a one-time photo return, not a later album visit', async () => {
  const { requestGalleryReturn, takeGalleryReturn } = await import('@/components/gallery-position')
  const values = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
  })
  expect(takeGalleryReturn('alice', '/events/7')).toBe(false)
  requestGalleryReturn('alice', '/events/7')
  expect(takeGalleryReturn('bob', '/events/7')).toBe(false)
  expect(takeGalleryReturn('alice', '/events/7')).toBe(true)
  expect(takeGalleryReturn('alice', '/events/7')).toBe(false)
  requestGalleryReturn('alice', '/events/7')
  expect(takeGalleryReturn('alice', '/events/8')).toBe(false)
  expect(takeGalleryReturn('alice', '/events/7')).toBe(false)
})
