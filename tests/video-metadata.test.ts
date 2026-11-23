import { expect, it, vi } from 'vitest'
import { parseVideoMetadata, videoGps, videoMetadata } from '../lib/video/video-metadata'

function atom(type: string, ...parts: Buffer[]) {
  const body = Buffer.concat(parts)
  const h = Buffer.alloc(8)
  h.writeUInt32BE(body.length + 8)
  h.write(type, 4, 'latin1')
  return Buffer.concat([h, body])
}
function mdta(values: Record<string, string>, iso = false) {
  const entries = Object.entries(values)
  const flags = Buffer.alloc(8)
  flags.writeUInt32BE(entries.length, 4)
  const keys = entries.map(([key]) => atom('mdta', Buffer.from(key)))
  const valuesAtoms = entries.map(([, value], i) => {
    const kind = Buffer.alloc(4)
    kind.writeUInt32BE(i + 1)
    const type = Buffer.alloc(8)
    type.writeUInt32BE(1)
    return atom(kind.toString('latin1'), atom('data', type, Buffer.from(value)))
  })
  return atom(
    'meta',
    ...(iso ? [Buffer.alloc(4)] : []),
    atom('keys', flags, ...keys),
    atom('ilst', ...valuesAtoms),
  )
}
it('extracts iPhone GPS including negative altitude, camera and software from both meta layouts', () => {
  for (const iso of [false, true]) {
    const m = parseVideoMetadata(
      atom(
        'moov',
        mdta(
          {
            'com.apple.quicktime.location.ISO6709': '+37.3317-122.0307-002.5/',
            'com.apple.quicktime.make': 'Apple',
            'com.apple.quicktime.model': 'iPhone',
            'com.apple.quicktime.software': 'iOS',
          },
          iso,
        ),
      ),
    )
    expect(m).toMatchObject({
      latitude: 37.3317,
      longitude: -122.0307,
      altitude: -2.5,
      cameraMake: 'Apple',
      cameraModel: 'iPhone',
      software: 'iOS',
    })
  }
})
it('reads legacy Android/QuickTime location in udta', () => {
  const s = Buffer.from('-33.8587+151.2140/')
  const h = Buffer.alloc(4)
  h.writeUInt16BE(s.length)
  expect(parseVideoMetadata(atom('moov', atom('udta', atom('©xyz', h, s))))).toMatchObject({
    latitude: -33.8587,
    longitude: 151.214,
    altitude: null,
  })
})
it('does not guess absent or malformed GPS', () => {
  for (const raw of [
    '',
    'Paris',
    '+91.0000+010.0000/',
    '+00.0000-181.0000/',
    '37.3,-122.0',
    '+37.3-122.0/garbage',
  ])
    expect(videoGps(raw)).toBeNull()
  expect(videoGps('+00.0000+000.0000/')).toEqual({ latitude: 0, longitude: 0, altitude: null })
  expect(parseVideoMetadata(atom('moov'))).toMatchObject({
    latitude: null,
    longitude: null,
    cameraMake: null,
    width: null,
  })
})
it('reads video track dimensions, ignoring audio tracks', () => {
  const tkhd = Buffer.alloc(84)
  tkhd.writeUInt32BE(1920 * 65536, 76)
  tkhd.writeUInt32BE(1080 * 65536, 80)
  const hdlr = Buffer.alloc(12)
  hdlr.write('vide', 8)
  expect(
    parseVideoMetadata(
      atom('moov', atom('trak', atom('tkhd', tkhd), atom('mdia', atom('hdlr', hdlr)))),
    ),
  ).toMatchObject({ width: 1920, height: 1080 })
})
it('skips large media payloads and reads only bounded movie metadata', async () => {
  const metadata = atom(
    'moov',
    mdta({ 'com.apple.quicktime.location.ISO6709': '+37.0000-122.0000/' }),
  )
  const offset = 100000008
  const mdat = Buffer.alloc(16)
  mdat.writeUInt32BE(offset)
  mdat.write('mdat', 4)
  const read = vi.fn(async (o: number, n: number) =>
    o === 0 ? mdat.subarray(0, n) : metadata.subarray(o - offset, o - offset + n),
  )
  expect(await videoMetadata(read, offset + metadata.length)).toMatchObject({
    latitude: 37,
    longitude: -122,
  })
  expect(read.mock.calls.every(([, n]) => n <= metadata.length)).toBe(true)
})
it('safely ignores truncated and oversized metadata', async () => {
  for (const data of [Buffer.from([0, 0, 0, 1, 109, 111, 111, 118]), atom('moov', Buffer.alloc(5))])
    await expect(
      videoMetadata(async (o, n) => data.subarray(o, o + n), data.length),
    ).resolves.toMatchObject({ latitude: null })
  const h = Buffer.alloc(16)
  h.writeUInt32BE(40 * 1024 * 1024)
  h.write('moov', 4)
  const read = vi.fn(async () => h)
  await videoMetadata(read, 40 * 1024 * 1024)
  expect(read).toHaveBeenCalledTimes(1)
})
