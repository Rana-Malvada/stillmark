import { expect, it } from 'vitest'
import { calendarConstraint } from '../lib/search/search-constraints'

it.each([
  'on September 1 2026',
  'on September 1st, 2026',
  'on 1 September 2026',
  'September 1 2026',
  'on 2026-09-01',
])('treats %s as the same exact date', (phrase) => {
  expect(calendarConstraint(`beach ${phrase}`)).toEqual({
    scene: 'beach',
    from: '2026-09-01',
    through: '2026-09-01',
  })
})
it('handles ranges and comparisons without widening precise days to album dates', () => {
  expect(calendarConstraint('photos between September 1 2026 and September 3 2026')).toEqual({
    scene: 'photos',
    from: '2026-09-01',
    through: '2026-09-03',
  })
  expect(calendarConstraint('photos before September 1 2026')).toEqual({
    scene: 'photos',
    from: null,
    through: '2026-08-31',
  })
  expect(calendarConstraint('photos after 2025')).toEqual({
    scene: 'photos',
    from: '2026-01-01',
    through: null,
  })
  expect(calendarConstraint('photos from 2024 through 2026')).toEqual({
    scene: 'photos',
    from: '2024-01-01',
    through: '2026-12-31',
  })
  expect(() => calendarConstraint('on February 30 2026')).toThrow()
  expect(() => calendarConstraint('between 2026 and 2024')).toThrow()
})
it('preserves scene words and extracts precise calendar bounds', () => {
  expect(calendarConstraint('Keith eating in September 2026')).toEqual({
    scene: 'Keith eating',
    from: '2026-09-01',
    through: '2026-09-30',
  })
  expect(calendarConstraint('beach on 2024-02-29')).toEqual({
    scene: 'beach',
    from: '2024-02-29',
    through: '2024-02-29',
  })
  expect(() => calendarConstraint('beach on 2025-02-29')).toThrow()
  expect(calendarConstraint('motocross racers with number 6')).toBeNull()
})

it('validates explicit GPS circles without inferring coordinates', async () => {
  const { geoConstraint } = await import('../lib/search/search-constraints')
  expect(geoConstraint('Keith within 10 miles of 40, -73')).toMatchObject({
    latitude: 40,
    longitude: -73,
    km: 16.09344,
    scene: 'Keith',
  })
  expect(() => geoConstraint('within 10 km of 95, -73')).toThrow()
  expect(geoConstraint('near Paris')).toBeNull()
})
