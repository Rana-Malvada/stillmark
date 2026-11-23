import { expect, it } from 'vitest'
import { createViewportCache } from '@/lib/travel/travel-viewport-cache'

it('reuses recent viewports, expires them, and isolates map instances', () => {
  let now = 0
  const a = createViewportCache<number>(() => now)
  const b = createViewportCache<number>(() => now)
  a.put('viewport', 3)
  expect(a.get('viewport')).toBe(3)
  expect(b.get('viewport')).toBeUndefined()
  now = 15000
  expect(a.get('viewport')).toBeUndefined()
})
it('bounds retained areas and clears all results on access rejection', () => {
  const cache = createViewportCache<number>()
  for (let i = 0; i < 13; i++) cache.put(String(i), i)
  expect(cache.get('0')).toBeUndefined()
  expect(cache.get('12')).toBe(12)
  cache.clear()
  expect(cache.get('12')).toBeUndefined()
})
