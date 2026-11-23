import { expect, it } from 'vitest'
import { costDay } from '@/lib/costs/cost-timezone'

it('keeps evening Eastern charges on the previous UTC calendar date', () => {
  expect(costDay('2026-10-23T00:00:00Z')).toBe('2026-10-22')
  expect(costDay('2026-10-23T03:59:59Z')).toBe('2026-10-22')
  expect(costDay('2026-10-23T04:00:00Z')).toBe('2026-10-23')
})
it('uses Eastern daylight and standard time, including repeated fall-back hours', () => {
  expect(costDay('2026-01-23T04:59:59Z')).toBe('2026-01-22')
  expect(costDay('2026-01-23T05:00:00Z')).toBe('2026-01-23')
  expect(costDay('2026-11-01T05:30:00Z')).toBe('2026-11-01')
  expect(costDay('2026-11-01T06:30:00Z')).toBe('2026-11-01')
})
it('preserves legacy UTC dates until the report has been rebuilt', () => {
  expect(costDay('2026-10-23T00:00:00Z', 'UTC')).toBe('2026-10-23')
})
