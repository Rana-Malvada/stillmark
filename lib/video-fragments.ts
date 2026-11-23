/** FFmpeg 6 emits empty sdtp boxes in HEVC initialization segments. Apple rejects
 * them. Replace only the empty box with same-size ISO BMFF padding; media bytes
 * and every byte-range offset remain unchanged. */
export function normalizeVideoInitialization(bytes: Buffer) {
  const data = Buffer.from(bytes)
  let changed = 0
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])
  function visit(start: number, end: number) {
    for (let at = start; at < end;) {
      if (at + 8 > end) throw new Error('Incomplete initialization box')
      const size = data.readUInt32BE(at)
      const type = data.toString('ascii', at + 4, at + 8)
      if (size < 8 || at + size > end) throw new Error('Invalid initialization box')
      if (type === 'sdtp' && size === 12 && data.readUInt32BE(at + 8) === 0) {
        data.write('free', at + 4, 'ascii')
        changed++
      }
      if (containers.has(type)) visit(at + 8, at + size)
      at += size
    }
  }
  visit(0, data.length)
  return { data, changed }
}
