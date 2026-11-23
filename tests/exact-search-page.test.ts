import { expect, it } from 'vitest'
import { exactSearchCursor, readExactSearchCursor } from '@/lib/exact-search-page'

it('preserves microsecond positions and null dates without treating a cursor as SQL', () => {
  const session = '11111111-1111-4111-8111-111111111111'
  for (const date of [null, '2026-10-29 12:01:00.123456+00']) {
    const position = { date, id: 42 }
    expect(readExactSearchCursor(exactSearchCursor(session, position, 50))).toEqual({
      session,
      position,
      seen: 50,
    })
  }
  for (const value of [
    'x:bad',
    'x:' +
      Buffer.from(
        JSON.stringify({ session, position: { date: "'); SELECT 1", id: 1 }, seen: 50 }),
      ).toString('base64url'),
    'x:' + 'a'.repeat(3000),
  ])
    expect(() => readExactSearchCursor(value)).toThrow('Invalid search cursor')
})
