import { HttpError } from '../http'
/** Validate bounded MP4/QuickTime container structure without decoding multi-GB video. */
export async function validateVideo(
  read: (offset: number, length: number) => Promise<Buffer>,
  length: number,
) {
  let offset = 0
  let metadata = false
  let media = false
  for (let count = 0; offset < length && count < 10000; count++) {
    const header = await read(offset, Math.min(16, length - offset))
    if (header.length < 8) throw new HttpError(422, 'Invalid MP4 or QuickTime video')
    let size = header.readUInt32BE(0)
    let headerSize = 8
    const type = header.toString('latin1', 4, 8)
    if (size === 1) {
      if (header.length < 16) throw new HttpError(422, 'Invalid video box')
      const large = header.readBigUInt64BE(8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError(422, 'Invalid video box')
      size = Number(large)
      headerSize = 16
    } else if (size === 0) size = length - offset
    if (size < headerSize || offset + size > length) throw new HttpError(422, 'Truncated video')
    if (type === 'moov' && size > headerSize) metadata = true
    if (type === 'mdat' && size > headerSize) media = true
    offset += size
  }
  if (offset !== length || !metadata || !media)
    throw new HttpError(422, 'Expected an MP4 or QuickTime video with movie metadata and media')
}
