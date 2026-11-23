import { expect, it } from 'vitest'
import { validateVideo } from '@/lib/video/video-validation'

function box(type: string, body = Buffer.from('test')) {
  const h = Buffer.alloc(8)
  h.writeUInt32BE(8 + body.length)
  h.write(type, 4)
  return Buffer.concat([h, body])
}
function check(b: Buffer) {
  return validateVideo(async (p, n) => b.subarray(p, p + n), b.length)
}
it('accepts movie containers including old QuickTime without ftyp', async () => {
  await expect(check(Buffer.concat([box('moov'), box('mdat')]))).resolves.toBeUndefined()
  await expect(
    check(Buffer.concat([box('ftyp'), box('mdat'), box('moov')])),
  ).resolves.toBeUndefined()
})
it('rejects renamed non-video, truncated boxes and metadata-only uploads', async () => {
  for (const b of [
    Buffer.from('<html>not a video</html>'),
    box('ftyp'),
    box('moov'),
    Buffer.concat([box('moov'), box('mdat')]).subarray(0, 20),
  ])
    await expect(check(b)).rejects.toMatchObject({ status: 422 })
})
it('skips multi-GB payloads without reading them into memory', async () => {
  const calls: number[] = []
  const length = 4 * 1024 ** 3
  const first = box('moov')
  await validateVideo(async (p, n) => {
    calls.push(n)
    if (p === 0) return first
    const h = Buffer.alloc(16)
    h.writeUInt32BE(length - first.length)
    h.write('mdat', 4)
    return h
  }, length)
  expect(calls).toEqual([16, 16])
})
