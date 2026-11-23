import { describe, expect, it } from 'vitest'
import { isPeopleOptionsPage } from '../lib/people/people-options-contract'
import { readClientResponse } from '../lib/client-response'

const person = { personId: '11111111-1111-1111-1111-111111111111', name: 'Ada' }
describe('people option response contract', () => {
  it('accepts actual names-only, empty and detailed pages', () => {
    expect(isPeopleOptionsPage({ people: [person], nextCursor: 'next' })).toBe(true)
    expect(isPeopleOptionsPage({ people: [], nextCursor: null }, true)).toBe(true)
    for (const coverFaceId of [null, 123]) {
      expect(
        isPeopleOptionsPage(
          { people: [{ ...person, coverFaceId, photoCount: 0 }], nextCursor: null },
          true,
        ),
      ).toBe(true)
    }
    expect(isPeopleOptionsPage({ people: [person], nextCursor: null }, true)).toBe(false)
  })
  it('rejects missing arrays, invalid rows, unbounded pages and malformed cursors', () => {
    for (const value of [
      null,
      [],
      {},
      { people: null, nextCursor: null },
      { people: {}, nextCursor: null },
      { people: [null], nextCursor: null },
      { people: [person] },
      { people: [person], nextCursor: 1 },
      { people: [person], nextCursor: '' },
      { people: Array(51).fill(person), nextCursor: null },
    ]) {
      expect(isPeopleOptionsPage(value)).toBe(false)
    }
    for (const patch of [
      { personId: null },
      { personId: '' },
      { name: null },
      { name: ' ' },
      { photoCount: -1 },
      { photoCount: '2' },
      { photoCount: 1.5 },
      { coverFaceId: 0 },
      { coverFaceId: '2' },
      { coverFaceId: 1.5 },
    ]) {
      expect(isPeopleOptionsPage({ people: [{ ...person, ...patch }], nextCursor: null })).toBe(
        false,
      )
    }
  })
  it('rejects malformed successful responses before a caller can update React state', async () => {
    await expect(
      readClientResponse(
        new Response(JSON.stringify({ people: {}, nextCursor: null })),
        'Unable to load names. Please retry.',
        isPeopleOptionsPage,
      ),
    ).rejects.toMatchObject({ status: 200 })
  })
  it('preserves authorization status for cached-option invalidation', async () => {
    for (const status of [401, 403, 404]) {
      await expect(
        readClientResponse(
          new Response('denied', { status }),
          'Unable to load names. Please retry.',
          isPeopleOptionsPage,
        ),
      ).rejects.toMatchObject({ status })
    }
  })
})
