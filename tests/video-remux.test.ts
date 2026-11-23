import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import ffmpeg from 'ffmpeg-static'

vi.mock('@/lib/media/image-urls', () => ({ getPresignedUrl: vi.fn() }))
vi.mock('@/lib/snowflake/stage-upload', () => ({ putFileToStage: vi.fn() }))
vi.mock('@/lib/postgres', () => ({ pgQuery: vi.fn() }))
vi.mock('@/lib/snowflake', () => ({ querySnowflake: vi.fn() }))
import { packageVideoFile } from '@/lib/video/video-compression'

it.each(['libx264', 'libx265'])(
  'packages %s HLS with identical encoded video/audio and untouched original',
  async (codec) => {
    const dir = await mkdtemp(join(tmpdir(), 'video-remux-test-'))
    const input = join(dir, 'original.mov')
    const output = join(dir, 'playback.mp4')
    const run = async (args: string[]) =>
      (await promisify(execFile)(ffmpeg!, ['-v', 'error', ...args], { timeout: 30000 })).stdout
    try {
      await run([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100',
        '-t',
        '2',
        '-c:v',
        codec,
        '-threads',
        '1',
        '-c:a',
        'aac',
        input,
      ])
      const original = await readFile(input)
      const hash = createHash('sha256').update(original).digest('hex')
      const result = await packageVideoFile(input, dir)
      expect(result.manifest).toContain('#EXT-X-ENDLIST')
      expect(result.manifest).toContain('#EXT-X-BYTERANGE')
      const tracks = (path: string) =>
        run([
          '-i',
          path,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0',
          '-c',
          'copy',
          '-f',
          'streamhash',
          '-hash',
          'sha256',
          '-',
        ])
      expect(await tracks(join(dir, 'playlist.m3u8'))).toBe(await tracks(input))
      expect(
        createHash('sha256')
          .update(await readFile(input))
          .digest('hex'),
      ).toBe(hash)
      const bytes = await readFile(output)
      const atoms: string[] = []
      for (let offset = 0; offset + 8 <= bytes.length;) {
        const size = bytes.readUInt32BE(offset)
        atoms.push(bytes.toString('ascii', offset + 4, offset + 8))
        if (size < 8) break
        offset += size
      }
      expect(atoms.indexOf('moov')).toBeLessThan(atoms.indexOf('mdat'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  60000,
)
