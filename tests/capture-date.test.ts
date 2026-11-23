import { expect, it } from 'vitest'
import { photoCaptureDate } from '../lib/capture-date'
import { videoCaptureDate } from '../lib/video/video-date'

function atom(type: string, ...parts: Buffer[]) {
  const body = Buffer.concat(parts)
  const h = Buffer.alloc(8)
  h.writeUInt32BE(body.length + 8)
  h.write(type, 4, 'latin1')
  return Buffer.concat([h, body])
}
function movie(version = 0) {
  const data = Buffer.alloc(version ? 12 : 8)
  data[0] = version
  const seconds = Date.parse('2026-06-03T19:54:29Z') / 1000 + 2082844800
  if (version) data.writeBigUInt64BE(BigInt(seconds), 4)
  else data.writeUInt32BE(seconds, 4)
  return atom('moov', atom('mvhd', data))
}
const read = (b: Buffer) => videoCaptureDate(async (o, n) => b.subarray(o, o + n), b.length)
it('applies photo offsets to the camera wall time', () => {
  expect(photoCaptureDate(new Date('2026-06-03T12:54:29Z'), '-07:00')).toBe(
    '2026-06-03T19:54:29.000Z',
  )
  expect(photoCaptureDate('2026-04-29T23:20:51.000Z', '+02:00')).toBe('2026-04-29T21:20:51.000Z')
  expect(photoCaptureDate(null, null)).toBeNull()
  expect(photoCaptureDate('bad', '-07:00')).toBeNull()
})
it('reads version 0 and 1 movie creation dates past media atoms', async () => {
  for (const v of [0, 1])
    expect(
      (
        await read(
          Buffer.concat([
            atom('ftyp', Buffer.alloc(8)),
            atom('mdat', Buffer.alloc(1024)),
            movie(v),
          ]),
        )
      )?.date,
    ).toBe('2026-06-03T19:54:29.000Z')
})
it('prefers the explicit QuickTime capture date and its offset', async () => {
  const key = Buffer.from('com.apple.quicktime.creationdate')
  const entry = Buffer.alloc(8)
  entry.writeUInt32BE(key.length + 8)
  entry.write('mdta', 4)
  const flags = Buffer.alloc(8)
  flags.writeUInt32BE(1, 4)
  const value = atom('data', Buffer.alloc(8), Buffer.from('2026-06-03T12:54:29-0700'))
  const item = atom('\x00\x00\x00\x01', value)
  const metadata = atom('meta', atom('keys', flags, entry, key), atom('ilst', item))
  const b = atom('moov', movie().subarray(8), metadata)
  expect(await read(b)).toEqual({
    date: '2026-06-03T19:54:29.000Z',
    raw: '2026-06-03T12:54:29-0700',
    source: 'com.apple.quicktime.creationdate',
  })
})
it('ignores missing, zero and malformed metadata', async () => {
  expect(await read(atom('moov', atom('mvhd', Buffer.alloc(8))))).toBeNull()
  expect(await read(Buffer.from([0, 0, 0, 1, 109, 111, 111, 118]))).toBeNull()
  expect(await read(atom('mdat', Buffer.alloc(30)))).toBeNull()
})
