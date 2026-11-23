import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpeg from 'ffmpeg-static'

vi.mock('@/lib/media/image-urls', () => ({ getPresignedUrl: vi.fn() }))
vi.mock('@/lib/snowflake/stage-upload', () => ({ putFileToStage: vi.fn() }))
vi.mock('@/lib/postgres', () => ({ pgQuery: vi.fn() }))
vi.mock('@/lib/snowflake', () => ({ querySnowflakeStorage: vi.fn(), querySnowflake: vi.fn() }))
import {
  compressionPlan,
  compressVideoFile,
  probeVideo,
  removeAnalysisCopy,
} from '@/lib/video/video-compression'

it('rejects impossible lengths rather than clipping a video', () => {
  expect(() => compressionPlan(NaN, true)).toThrow()
  expect(() => compressionPlan(100000, true)).toThrow('too long')
  expect(compressionPlan(600, true).videoKbps).toBeLessThan(1500)
})
it('refuses deletion of any original path', async () => {
  await expect(removeAnalysisCopy('originals/clip.mov')).rejects.toThrow()
})
it('compresses a real file over 100 MB, keeps audio/duration and leaves original bytes unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'video-compression-test-'))
  const input = join(dir, 'original.avi')
  const output = join(dir, 'analysis.mp4')
  try {
    await promisify(execFile)(
      ffmpeg!,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100',
        '-t',
        '3',
        '-c:v',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        '-threads',
        '1',
        '-c:a',
        'pcm_s16le',
        input,
      ],
      { timeout: 30000 },
    )
    const hash = async () =>
      createHash('sha256')
        .update(await readFile(input))
        .digest('hex')
    const before = await hash()
    expect((await stat(input)).size).toBeGreaterThan(100000000)
    const result = await compressVideoFile(input, output)
    const probe = await probeVideo(output)
    expect(result.bytes).toBeLessThan(100000000)
    expect(probe.hasAudio).toBe(true)
    expect(Math.abs(probe.seconds - 3)).toBeLessThan(0.2)
    expect(probe.streams.find((s) => s.codec_type === 'video')!.width).toBeLessThanOrEqual(720)
    expect(await hash()).toBe(before)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 60000)
