import { atoms, movieDate, readVideoMovie } from './video-date'

// MOV/iPhone mdta and MP4/Android ©xyz use signed ISO 6709 coordinates.
export function videoGps(raw: string) {
  const match = /^([+-]\d{2}(?:\.\d+)?)([+-]\d{3}(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\/?$/.exec(
    raw.trim(),
  )
  if (!match) return null
  const latitude = Number(match[1])
  const longitude = Number(match[2])
  const altitude = match[3] === undefined ? null : Number(match[3])
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    (altitude !== null && !Number.isFinite(altitude))
  )
    return null
  return { latitude, longitude, altitude }
}
export function parseVideoMetadata(movie: Buffer) {
  const root = atoms(movie).find((a) => a.type === 'moov')
  const tags: Record<string, string> = {}
  let width: number | null = null
  let height: number | null = null
  if (root) {
    const children = atoms(movie, root.payload, root.end)
    const containers = [...children]
    for (const udta of children.filter((a) => a.type === 'udta'))
      containers.push(...atoms(movie, udta.payload, udta.end))
    const text = (start: number, end: number) =>
      movie
        .toString('utf8', start, Math.min(end, start + 4096))
        .replace(/\0/g, '')
        .trim()
    for (const a of containers) {
      if (['©xyz', '©mak', '©mod', '©swr'].includes(a.type) && a.payload + 4 <= a.end) {
        // Legacy user-data strings have a 16-bit byte count and language code.
        const length = movie.readUInt16BE(a.payload)
        if (length > 0 && a.payload + 4 + length <= a.end)
          tags[a.type] = text(a.payload + 4, a.payload + 4 + length)
      }
      if (a.type !== 'meta') continue
      let entries = atoms(movie, a.payload, a.end)
      if (!entries.some((e) => e.type === 'keys' || e.type === 'ilst'))
        entries = atoms(movie, a.payload + 4, a.end)
      const keys = entries.find((e) => e.type === 'keys')
      const list = entries.find((e) => e.type === 'ilst')
      const names = new Map<number, string>()
      if (keys && keys.payload + 8 <= keys.end) {
        const count = Math.min(movie.readUInt32BE(keys.payload + 4), 10000)
        for (let p = keys.payload + 8, i = 1; i <= count && p + 8 <= keys.end; i++) {
          const length = movie.readUInt32BE(p)
          if (length < 8 || p + length > keys.end) break
          names.set(i, text(p + 8, p + length))
          p += length
        }
      }
      if (list)
        for (const item of atoms(movie, list.payload, list.end)) {
          const name = names.get(movie.readUInt32BE(item.start + 4)) ?? item.type
          if (
            ![
              'com.apple.quicktime.location.ISO6709',
              'com.apple.quicktime.make',
              'com.apple.quicktime.model',
              'com.apple.quicktime.software',
              'com.apple.quicktime.creationdate',
              '©xyz',
              '©mak',
              '©mod',
              '©swr',
            ].includes(name)
          )
            continue
          for (const data of atoms(movie, item.payload, item.end))
            if (data.type === 'data' && data.payload + 8 <= data.end) {
              // Only UTF-8 text; do not interpret binary metadata as coordinates.
              if ((movie.readUInt32BE(data.payload) & 0xffffff) === 1)
                tags[name] = text(data.payload + 8, data.end)
            }
        }
    }
    for (const trak of children.filter((a) => a.type === 'trak')) {
      const track = atoms(movie, trak.payload, trak.end)
      const mdia = track.find((a) => a.type === 'mdia')
      const tkhd = track.find((a) => a.type === 'tkhd')
      const hdlr = mdia && atoms(movie, mdia.payload, mdia.end).find((a) => a.type === 'hdlr')
      if (
        !tkhd ||
        !hdlr ||
        hdlr.payload + 12 > hdlr.end ||
        movie.toString('ascii', hdlr.payload + 8, hdlr.payload + 12) !== 'vide'
      )
        continue
      const version = movie[tkhd.payload]
      const required = version === 0 ? 84 : version === 1 ? 96 : 0
      if (!required || tkhd.end - tkhd.payload < required) continue
      const w = movie.readUInt32BE(tkhd.payload + required - 8) / 65536
      const h = movie.readUInt32BE(tkhd.payload + required - 4) / 65536
      if (w > 0 && h > 0 && w <= 65535 && h <= 65535) {
        width = Math.round(w)
        height = Math.round(h)
        break
      }
    }
  }
  const gps = videoGps(tags['com.apple.quicktime.location.ISO6709'] ?? tags['©xyz'] ?? '')
  return {
    capture: movieDate(movie),
    latitude: gps?.latitude ?? null,
    longitude: gps?.longitude ?? null,
    altitude: gps?.altitude ?? null,
    cameraMake: tags['com.apple.quicktime.make'] ?? tags['©mak'] ?? null,
    cameraModel: tags['com.apple.quicktime.model'] ?? tags['©mod'] ?? null,
    software: tags['com.apple.quicktime.software'] ?? tags['©swr'] ?? null,
    width,
    height,
    tags,
  }
}
export async function videoMetadata(
  read: (offset: number, length: number) => Promise<Buffer>,
  size: number,
) {
  const movie = await readVideoMovie(read, size)
  return parseVideoMetadata(movie ?? Buffer.alloc(0))
}
