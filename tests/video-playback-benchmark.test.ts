// Opt-in local benchmark. Never connects to production or uploads outputs.
import { it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpeg from 'ffmpeg-static'

vi.mock('@/lib/media/image-urls', () => ({ getPresignedUrl: vi.fn() }))
vi.mock('@/lib/snowflake/stage-upload', () => ({ putFileToStage: vi.fn() }))
vi.mock('@/lib/postgres', () => ({ pgQuery: vi.fn() }))
vi.mock('@/lib/snowflake', () => ({ querySnowflakeStorage: vi.fn(), querySnowflake: vi.fn() }))
import { encodeAdaptivePlayback, encodePlaybackRendition } from '@/lib/video/video-compression'

it.skipIf(!process.env.VIDEO_BENCHMARK_INPUT)(
  'compares the sequential and shared decode pipelines locally',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'playback-benchmark-'))
    try {
      const input = join(dir, 'sample.mov')
      await promisify(execFile)(
        ffmpeg!,
        [
          '-v',
          'error',
          '-i',
          process.env.VIDEO_BENCHMARK_INPUT!,
          '-t',
          '10',
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-c',
          'copy',
          input,
        ],
        { timeout: 60000 },
      )
      const report = []
      for (const mode of ['sequential-fast', 'adaptive-fast', 'adaptive-veryfast'] as const) {
        const started = performance.now()
        const results =
          mode === 'sequential-fast'
            ? [
                await encodePlaybackRendition(input, join(dir, mode, '720'), 1280, 3500),
                await encodePlaybackRendition(input, join(dir, mode, '1080'), 1920, 8000),
              ]
            : await encodeAdaptivePlayback(
                input,
                join(dir, mode),
                mode === 'adaptive-fast' ? 'fast' : 'veryfast',
              )
        report.push({
          mode,
          seconds: (performance.now() - started) / 1000,
          bytes: results.map((r) => r.bytes),
          dimensions: results.map((r) => [r.width, r.height]),
        })
        console.log(JSON.stringify(report[report.length - 1]))
      }
      const compare = await promisify(execFile)(
        ffmpeg!,
        [
          '-hide_banner',
          '-threads',
          '2',
          '-i',
          join(dir, 'sequential-fast/1080/playback.mp4'),
          '-threads',
          '2',
          '-i',
          join(dir, 'adaptive-veryfast/1080/playback.mp4'),
          '-filter_complex_threads',
          '2',
          '-lavfi',
          'ssim',
          '-f',
          'null',
          '-',
        ],
        { timeout: 120000 },
      )
      const similarity = compare.stderr.match(/SSIM Y:[^\n]+/)?.[0]
      await mkdir('output', { recursive: true })
      for (const mode of ['sequential-fast', 'adaptive-veryfast'])
        await promisify(execFile)(
          ffmpeg!,
          [
            '-v',
            'error',
            '-ss',
            '4',
            '-i',
            join(dir, mode, '1080/playback.mp4'),
            '-frames:v',
            '1',
            '-y',
            `output/playback-${mode}.png`,
          ],
          { timeout: 30000 },
        )
      await writeFile(
        'output/playback-benchmark.json',
        JSON.stringify({ sampleSeconds: 10, report, similarity }, null, 2),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  600000,
)
