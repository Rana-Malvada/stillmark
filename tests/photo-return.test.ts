import { expect, it } from 'vitest'
import { photoInfoPath, photoReturnPath } from '@/lib/photos/photo-return'

it('restores the displayed photo, info panel, face and favorites ordering', () => {
  const path = photoInfoPath(42, 'context=favorites&sort=oldest&media=photo', true, 91, 140.6)
  expect(photoReturnPath(path)).toBe(path)
  const url = new URL(path, 'https://photos.example')
  expect(url.pathname).toBe('/photos/42')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    context: 'favorites',
    sort: 'oldest',
    media: 'photo',
    info: 'expanded',
    face: '91',
    infoScroll: '141',
  })
  const personUrl = `/people/person-id?returnTo=${encodeURIComponent(path)}`
  expect(new URL(personUrl, url).searchParams.get('returnTo')).toBe(path)
})
it('keeps ordinary info open without introducing a face selection', () => {
  expect(photoInfoPath(7, '', false, null, 0)).toBe('/photos/7?info=open&infoScroll=0')
})
it('rejects external, unrelated and malformed return destinations', () => {
  for (const path of [
    undefined,
    ['/photos/7'],
    'https://evil.test',
    '//evil.test',
    '/people/7',
    '/photos/0',
    '/photos/7/../../api',
    '/photos/7?x=\\evil',
    '/photos/7\n',
    '/photos/7#fragment',
  ])
    expect(photoReturnPath(path)).toBeNull()
})
