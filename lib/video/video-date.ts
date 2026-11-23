// Read only QuickTime/MP4 metadata atoms, never decode video frames.
type Reader = (offset: number, length: number) => Promise<Buffer>
type Atom = { type: string; start: number; end: number; payload: number }
export function atoms(buffer: Buffer, start = 0, end = buffer.length): Atom[] {
  const result: Atom[] = []
  for (let p = start; p + 8 <= end && result.length < 10000;) {
    let size = buffer.readUInt32BE(p)
    let header = 8
    if (size === 1) {
      if (p + 16 > end) break
      const big = buffer.readBigUInt64BE(p + 8)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break
      size = Number(big)
      header = 16
    } else if (size === 0) size = end - p
    if (size < header || p + size > end) break
    result.push({
      type: buffer.toString('latin1', p + 4, p + 8),
      start: p,
      end: p + size,
      payload: p + header,
    })
    p += size
  }
  return result
}
function validDate(raw: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(raw))
    return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) && ms >= Date.UTC(1970, 0, 1) && ms <= Date.now() + 86400000
    ? new Date(ms).toISOString()
    : null
}
export function movieDate(buffer: Buffer): { date: string; raw: string; source: string } | null {
  const top = atoms(buffer)
  const movie = top.find((a) => a.type === 'moov')
  if (!movie) return null
  const children = atoms(buffer, movie.payload, movie.end)
  const containers = [...children]
  for (const udta of children.filter((a) => a.type === 'udta'))
    containers.push(...atoms(buffer, udta.payload, udta.end))
  for (const meta of containers.filter((a) => a.type === 'meta')) {
    // QuickTime meta has no version field; ISO meta has a four-byte full-box header.
    let entries = atoms(buffer, meta.payload, meta.end)
    if (!entries.some((a) => a.type === 'keys')) entries = atoms(buffer, meta.payload + 4, meta.end)
    const keys = entries.find((a) => a.type === 'keys')
    const list = entries.find((a) => a.type === 'ilst')
    if (!keys || !list || keys.payload + 8 > keys.end) continue
    const count = buffer.readUInt32BE(keys.payload + 4)
    let p = keys.payload + 8
    let dateIndex = 0
    for (let i = 1; i <= Math.min(count, 10000) && p + 8 <= keys.end; i++) {
      const size = buffer.readUInt32BE(p)
      if (size < 8 || p + size > keys.end) break
      if (buffer.toString('utf8', p + 8, p + size) === 'com.apple.quicktime.creationdate')
        dateIndex = i
      p += size
    }
    if (!dateIndex) continue
    for (const item of atoms(buffer, list.payload, list.end)) {
      if (buffer.readUInt32BE(item.start + 4) !== dateIndex) continue
      for (const data of atoms(buffer, item.payload, item.end)) {
        if (data.type !== 'data' || data.payload + 8 > data.end) continue
        const raw = buffer
          .toString('utf8', data.payload + 8, data.end)
          .replace(/\0+$/, '')
          .trim()
        const date = validDate(raw)
        if (date) return { date, raw, source: 'com.apple.quicktime.creationdate' }
      }
    }
  }
  const mvhd = children.find((a) => a.type === 'mvhd')
  if (!mvhd || mvhd.payload + 8 > mvhd.end) return null
  const version = buffer[mvhd.payload]
  if (version > 1 || (version === 1 && mvhd.payload + 12 > mvhd.end)) return null
  const seconds =
    version === 1
      ? Number(buffer.readBigUInt64BE(mvhd.payload + 4))
      : buffer.readUInt32BE(mvhd.payload + 4)
  const ms = (seconds - 2082844800) * 1000
  if (!Number.isSafeInteger(ms) || ms < Date.UTC(1970, 0, 1) || ms > Date.now() + 86400000)
    return null
  const date = new Date(ms).toISOString()
  return { date, raw: date, source: 'mvhd.creation_time' }
}
export async function readVideoMovie(read: Reader, size: number) {
  for (let p = 0, n = 0; p + 8 <= size && n < 10000; n++) {
    const head = await read(p, Math.min(16, size - p))
    if (head.length < 8) return null
    let length = head.readUInt32BE(0)
    let header = 8
    if (length === 1) {
      if (head.length < 16) return null
      const big = head.readBigUInt64BE(8)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null
      length = Number(big)
      header = 16
    } else if (length === 0) length = size - p
    if (length < header || p + length > size) return null
    if (head.toString('ascii', 4, 8) === 'moov') {
      if (length > 32 * 1024 * 1024) return null
      const movie = await read(p, length)
      return movie.length === length ? movie : null
    }
    p += length
  }
  return null
}

export async function videoCaptureDate(read: Reader, size: number) {
  const movie = await readVideoMovie(read, size)
  return movie ? movieDate(movie) : null
}
