import { expect, it, vi } from 'vitest'

vi.mock('@/lib/postgres', () => ({ pgQuery: vi.fn(), pgQueryOne: vi.fn() }))
import { loggedSearchQuery } from '@/lib/people/people-search'

const person = (name: string, personId: number) =>
  ({ name, personId }) as Parameters<typeof loggedSearchQuery>[1] extends never ? never : any

it('redacts named and excluded people from the logged query', () => {
  expect(
    loggedSearchQuery('beach with Ada without Grace Hopper', {
      people: [person('Ada', 1)],
      filters: { excludedPeople: [person('Grace Hopper', 2)] },
    }),
  ).toBe('beach with [person] without [person]')
  expect(loggedSearchQuery('beach', { people: [] })).toBe('beach')
  expect(loggedSearchQuery('beach with Ada', {})).toBe('beach with Ada')
})
it('withholds the query when the result could not report its people', () => {
  expect(
    loggedSearchQuery('beach without Grace Hopper', {
      people: [],
      notice: 'Your library changed during this search.',
    }),
  ).toBe('[query withheld]')
})
