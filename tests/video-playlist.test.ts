import { expect, it } from 'vitest'
import { videoPlaylist } from '@/lib/video/video-playlist'

const manifest =
  '#EXTM3U\n#EXT-X-MAP:URI="playback.mp4",BYTERANGE="1476@0"\n#EXTINF:6,\n#EXT-X-BYTERANGE:500@1476\nplayback.mp4\n#EXT-X-ENDLIST\n'
it('rewrites initialization and segments through the authorized media endpoint', () => {
  const result = videoPlaylist(manifest, '/api/images?path=display%2Fvideo%2Fa.mp4')
  expect(result).toContain('URI="/api/images?path=display%2Fvideo%2Fa.mp4"')
  expect(result).toContain('\n/api/images?path=display%2Fvideo%2Fa.mp4\n')
  expect(result).toContain('#EXT-X-BYTERANGE:500@1476')
})
it('rejects injected external segments, keys and unsafe media URLs', () => {
  for (const bad of [
    manifest.replace('\nplayback.mp4', '\nhttps://evil.test/x'),
    manifest.replace('#EXTINF:', '#EXT-X-KEY:METHOD=AES-128,URI="https://evil.test/key"\n#EXTINF:'),
    manifest.replace('#EXT-X-ENDLIST', ''),
  ])
    expect(() => videoPlaylist(bad, '/media')).toThrow()
  for (const url of ['//evil.test/x', 'https://evil.test/x', '/x\n#EXT-X-KEY:x', '/x"'])
    expect(() => videoPlaylist(manifest, url)).toThrow()
})
