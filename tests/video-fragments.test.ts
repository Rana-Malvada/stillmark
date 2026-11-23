import { expect, it } from 'vitest'
import { normalizeVideoInitialization } from '@/lib/video-fragments'

const box = (name: string, body: Buffer) => {
  const h = Buffer.alloc(8)
  h.writeUInt32BE(body.length + 8)
  h.write(name, 4)
  return Buffer.concat([h, body])
}
it('replaces only the invalid empty sample-dependency box without shifting offsets', () => {
  const empty = box('sdtp', Buffer.alloc(4))
  const populated = box('sdtp', Buffer.from([0, 0, 0, 0, 1]))
  const original = box(
    'moov',
    box('trak', box('mdia', box('minf', box('stbl', Buffer.concat([empty, populated]))))),
  )
  const result = normalizeVideoInitialization(original)
  expect(result.changed).toBe(1)
  expect(result.data.length).toBe(original.length)
  expect(result.data.subarray(-populated.length)).toEqual(populated)
  expect(original.includes(Buffer.from('free'))).toBe(false)
  expect(normalizeVideoInitialization(result.data).changed).toBe(0)
})
it('rejects truncated or malformed initialization boxes', () => {
  expect(() =>
    normalizeVideoInitialization(Buffer.from([0, 0, 0, 50, 109, 111, 111, 118])),
  ).toThrow()
  expect(() => normalizeVideoInitialization(Buffer.alloc(7))).toThrow()
})
