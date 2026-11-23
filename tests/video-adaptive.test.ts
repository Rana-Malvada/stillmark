import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
import { adaptivePlaylist } from '@/lib/video/video-playlist'

it('converts HEVC to independently decodable H264/AAC without modifying the original', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'video-adaptive-test-'))
  const input = join(dir, 'original.mov')
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
      '5',
      '-c:v',
      'libx265',
      '-threads',
      '1',
      '-c:a',
      'aac',
      input,
    ])
    const original = await readFile(input)
    const result = await encodePlaybackRendition(input, join(dir, '720'), 1280, 3500)
    expect(result.manifest).toContain('#EXT-X-INDEPENDENT-SEGMENTS')
    expect([...result.manifest.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]))).toEqual([5])
    await run(['-i', join(dir, '720/playlist.m3u8'), '-f', 'null', '-'])
    expect(await readFile(input)).toEqual(original)
    const master = adaptivePlaylist(
      [{ name: '720', stage_path: 'x', playlist: result.manifest, ...result }],
      (name) => `/playlist?variant=${name}`,
    )
    expect(master).toContain('CODECS="avc1.')
    expect(master).toContain('RESOLUTION=320x240')
    expect(master).toContain('/playlist?variant=720')
    expect(() =>
      adaptivePlaylist([{ name: 'bad', stage_path: 'x', playlist: '', bandwidth: 1 }], () => '/'),
    ).toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 60000)

it('creates aligned adaptive variants in one pass and skips duplicate small variants', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adaptive-fanout-'))
  const run = async (args: string[]) =>
    (await promisify(execFile)(ffmpeg!, ['-v', 'error', ...args], { timeout: 60000 })).stdout
  try {
    const input = join(dir, 'source.mp4')
    await run([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1440x810:rate=24',
      '-t',
      '7',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-threads',
      '2',
      input,
    ])
    const original = await readFile(input)
    const results = await encodeAdaptivePlayback(input, join(dir, 'outputs'), 'veryfast')
    expect(results.map((r) => r.name)).toEqual(['720', '1080'])
    expect(results.map((r) => [r.width, r.height])).toEqual([
      [1280, 720],
      [1440, 810],
    ])
    expect(results[0].manifest.match(/#EXTINF:[^\n]+/g)).toEqual(
      results[1].manifest.match(/#EXTINF:[^\n]+/g),
    )
    for (const result of results) await run(['-i', result.output, '-f', 'null', '-'])
    expect(await readFile(input)).toEqual(original)
    const small = join(dir, 'small.mp4')
    await run([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=240x320:rate=24',
      '-t',
      '1',
      '-c:v',
      'libx264',
      small,
    ])
    const copies = await encodeAdaptivePlayback(small, join(dir, 'small-outputs'))
    expect(copies).toHaveLength(1)
    expect([copies[0].width, copies[0].height]).toEqual([240, 320])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 120000)

it('prepares playback when an unsupported first audio track has a valid AAC fallback', async () => {
  const { writeFile } = await import('node:fs/promises')
  const { probeVideo } = await import('@/lib/video/video-compression')
  const dir = await mkdtemp(join(tmpdir(), 'video-audio-fallback-'))
  const input = join(dir, 'spatial.mov')
  try {
    await promisify(execFile)(
      ffmpeg!,
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=24',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-map',
        '1:a',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        input,
      ],
      { timeout: 30000 },
    )
    // Simulate the older decoder's view of APAC while retaining a real second
    // AAC stream. Private user media is never embedded in the test fixture.
    const bytes = await readFile(input)
    const entry = bytes.indexOf(Buffer.from('mp4a'))
    expect(entry).toBeGreaterThan(0)
    bytes.write('apac', entry, 'ascii')
    // Remove this track's AAC decoder descriptor as well as its sample tag.
    const descriptor = bytes.indexOf(Buffer.from('esds'), entry)
    expect(descriptor).toBeGreaterThan(entry)
    bytes.write('free', descriptor, 'ascii')
    await writeFile(input, bytes)
    const original = Buffer.from(bytes)
    const before = await probeVideo(input)
    expect(before.streams.filter((s) => s.codec_type === 'audio')).toHaveLength(2)
    await expect(
      promisify(execFile)(ffmpeg!, [
        '-v',
        'error',
        '-i',
        input,
        '-map',
        '0:a:0',
        '-f',
        'null',
        '-',
      ]),
    ).rejects.toThrow()
    const target = join(dir, 'rendition')
    await encodePlaybackRendition(input, target, 720, 1500)
    const after = await probeVideo(join(target, 'playback.mp4'))
    expect(after.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac')).toBe(true)
    expect(after.seconds).toBeGreaterThan(1.9)
    await promisify(execFile)(
      ffmpeg!,
      ['-v', 'error', '-i', join(target, 'playback.mp4'), '-f', 'null', '-'],
      { timeout: 30000 },
    )
    expect(await readFile(input)).toEqual(original)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)
