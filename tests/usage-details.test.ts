import { expect, it } from 'vitest'
import { watchedSeconds } from '@/lib/watch-time'
import { cleanUsageDetails } from '@/lib/costs/usage-details'

it('counts real elapsed playback instead of skipped media or time in hidden/suspended tabs', () => {
  expect(watchedSeconds(1, 1, 1, true)).toBe(1)
  expect(watchedSeconds(1, 2, 2, true)).toBe(1)
  expect(watchedSeconds(1, 0, 1, true)).toBe(0)
  expect(watchedSeconds(1, 40, 1, true)).toBe(0)
  expect(watchedSeconds(1, 1, 1, false)).toBe(0)
  expect(watchedSeconds(60, 60, 1, true)).toBe(0)
  expect(watchedSeconds(1, -20, 1, true)).toBe(0)
})
it('drops arbitrary metadata and unsafe numeric values', () => {
  expect(
    cleanUsageDetails({
      query: 'car\nboat',
      bytes: Infinity,
      seconds: -2,
      mode: 'semantic',
      password: 'secret',
      url: 'signed',
    } as any),
  ).toEqual({ query: 'car boat', mode: 'semantic' })
  expect(cleanUsageDetails({ query: 'a'.repeat(400) }).query).toHaveLength(300)
})
