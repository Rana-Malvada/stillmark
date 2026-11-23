import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { VideoPreparationError } from './video-preparation-error'
import { videoAudioMap } from '../video-audio'
import { normalizeVideoInitialization } from '../video-fragments'
import { VIDEO_MAX_BYTES } from './video-analysis-format'
import { run } from './process'

export function compressionPlan(seconds: number, hasAudio: boolean) {
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new VideoPreparationError('The video duration could not be read.')
  const audioKbps = hasAudio ? 96 : 0
  const videoKbps = Math.min(1500, Math.floor((90_000_000 * 8) / seconds / 1000) - audioKbps)
  if (videoKbps < 100)
    throw new VideoPreparationError(
      'This video is too long to fit under 100 MB with usable picture and audio quality. No analysis was run.',
    )
  return { videoKbps, audioKbps, edge: videoKbps < 400 ? 480 : 720 }
}

export async function probeVideo(file: string) {
  const data = JSON.parse(
    await run(
      'ffprobe',
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-show_entries',
        'format=duration:stream=codec_type,codec_name,pix_fmt,width,height,duration,color_transfer,avg_frame_rate,r_frame_rate',
        '-of',
        'json',
        file,
      ],
      30000,
    ),
  )
  const streams = data.streams as {
    codec_type: string
    codec_name?: string
    pix_fmt?: string
    duration?: string
    width?: number
    height?: number
    color_transfer?: string
    avg_frame_rate?: string
    r_frame_rate?: string
  }[]
  if (!streams.some((s) => s.codec_type === 'video'))
    throw new VideoPreparationError('The file has no readable video track.')
  return {
    seconds: Number(data.format?.duration),
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    streams,
  }
}

/** Repackage the primary video/audio without re-encoding or resizing either. */
export async function remuxVideoFile(input: string, output: string, signal?: AbortSignal) {
  const before = await probeVideo(input)
  await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      input,
      '-map',
      '0:v:0',
      ...videoAudioMap(before.streams),
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      output,
    ],
    10 * 60 * 1000,
    signal,
  )
  const bytes = (await stat(output)).size
  const after = await probeVideo(output)
  const a = before.streams.find((s) => s.codec_type === 'video')!
  const b = after.streams.find((s) => s.codec_type === 'video')!
  if (
    bytes <= 0 ||
    a.width !== b.width ||
    a.height !== b.height ||
    !Number.isFinite(after.seconds) ||
    Math.abs(after.seconds - before.seconds) > 0.25 ||
    (before.hasAudio && !after.hasAudio)
  )
    throw new VideoPreparationError(
      'The playback copy failed validation. The original is unchanged.',
    )
  return { bytes, duration: after.seconds }
}

/** Lossless HLS: a single fragmented MP4 with timed byte ranges, no transcoding. */
export async function packageVideoFile(input: string, dir: string) {
  const before = await probeVideo(input)
  const output = join(dir, 'playback.mp4')
  const playlist = join(dir, 'playlist.m3u8')
  await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      input,
      '-map',
      '0:v:0',
      ...videoAudioMap(before.streams),
      '-c',
      'copy',
      '-f',
      'hls',
      '-hls_time',
      '6',
      '-hls_playlist_type',
      'vod',
      '-hls_segment_type',
      'fmp4',
      '-hls_flags',
      'single_file+independent_segments',
      '-hls_segment_filename',
      output,
      playlist,
    ],
    10 * 60 * 1000,
  )
  const manifest = await readFile(playlist, 'utf8')
  const bytes = (await stat(output)).size
  const seconds = [...manifest.matchAll(/#EXTINF:([\d.]+),/g)].reduce((n, m) => n + Number(m[1]), 0)
  if (
    bytes <= 0 ||
    !Number.isFinite(before.seconds) ||
    Math.abs(seconds - before.seconds) > Math.max(0.25, before.seconds * 0.001) ||
    !manifest.includes('#EXT-X-ENDLIST')
  )
    throw new VideoPreparationError(
      'The streaming copy failed validation. The original is unchanged.',
    )
  // Normalize the initialization metadata without moving any fragment offsets.
  const init = /#EXT-X-MAP:URI="playback\.mp4",BYTERANGE="(\d+)@0"/.exec(manifest)
  const initBytes = Number(init?.[1])
  if (!initBytes || initBytes > 1024 * 1024)
    throw new VideoPreparationError('Invalid stream initialization.')
  const handle = await open(output, 'r+')
  try {
    const header = Buffer.alloc(initBytes)
    const read = await handle.read(header, 0, initBytes, 0)
    if (read.bytesRead !== initBytes)
      throw new VideoPreparationError('Incomplete stream initialization.')
    const normalized = normalizeVideoInitialization(header)
    if (normalized.changed) await handle.write(normalized.data, 0, initBytes, 0)
  } finally {
    await handle.close()
  }
  return { manifest, bytes, output }
}

/** Browser playback uses bounded-bitrate H.264/AAC; the source is never modified. */
export async function encodePlaybackRendition(
  input: string,
  dir: string,
  edge: number,
  maxKbps: number,
) {
  await mkdir(dir, { recursive: true })
  const source = await probeVideo(input)
  const video = source.streams.find((s) => s.codec_type === 'video')!
  const hdr = ['arib-std-b67', 'smpte2084'].includes(video.color_transfer || '')
  const filters = [
    `scale=w='min(${edge},iw)':h='min(${edge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
  ]
  if (hdr)
    filters.push(
      'zscale=t=linear:npl=100',
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
    )
  const [num, den] = (video.r_frame_rate || '30/1').split('/').map(Number)
  const rate = Number.isFinite(num / den) && num / den > 0 ? Math.min(60, num / den) : 30
  filters.push('format=yuv420p', 'setsar=1', `fps=${rate}`)
  const output = join(dir, 'playback.mp4')
  const playlist = join(dir, 'playlist.m3u8')
  await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-protocol_whitelist',
      'file,pipe',
      '-threads',
      '2',
      '-i',
      input,
      '-map',
      '0:v:0',
      ...videoAudioMap(source.streams),
      '-sn',
      '-dn',
      '-vf',
      filters.join(','),
      '-filter_threads',
      '2',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '18',
      '-maxrate',
      `${maxKbps}k`,
      '-bufsize',
      `${maxKbps * 2}k`,
      '-threads',
      '2',
      '-pix_fmt',
      'yuv420p',
      '-force_key_frames',
      'expr:gte(t,n_forced*2)',
      '-sc_threshold',
      '0',
      ...(hdr
        ? [
            '-color_primaries',
            'bt709',
            '-color_trc',
            'bt709',
            '-colorspace',
            'bt709',
            '-color_range',
            'tv',
          ]
        : []),
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-map_metadata',
      '-1',
      '-f',
      'hls',
      '-hls_time',
      '6',
      '-hls_playlist_type',
      'vod',
      '-hls_segment_type',
      'fmp4',
      '-hls_flags',
      'single_file+independent_segments',
      '-hls_segment_filename',
      output,
      playlist,
    ],
    2 * 60 * 60 * 1000,
  )
  return validatePlaybackRendition(dir, source, rate)
}

async function validatePlaybackRendition(
  dir: string,
  source: Awaited<ReturnType<typeof probeVideo>>,
  rate: number,
) {
  const video = source.streams.find((s) => s.codec_type === 'video')!
  const output = join(dir, 'playback.mp4')
  const playlist = join(dir, 'playlist.m3u8')
  const manifest = await readFile(playlist, 'utf8')
  const bytes = (await stat(output)).size
  const seconds = [...manifest.matchAll(/#EXTINF:([\d.]+),/g)].reduce((n, m) => n + Number(m[1]), 0)
  const duration = Number(video.duration) || source.seconds
  if (
    !bytes ||
    !Number.isFinite(duration) ||
    Math.abs(seconds - duration) > Math.max(0.5, duration * 0.002) ||
    !manifest.includes('#EXT-X-ENDLIST')
  )
    throw new VideoPreparationError('Playback duration validation failed.')
  const initBytes = Number(/BYTERANGE="(\d+)@0"/.exec(manifest)?.[1])
  if (!initBytes || initBytes > 1024 * 1024)
    throw new VideoPreparationError('Invalid playback initialization.')
  const handle = await open(output, 'r+')
  try {
    const header = Buffer.alloc(initBytes)
    const read = await handle.read(header, 0, initBytes, 0)
    if (read.bytesRead !== initBytes)
      throw new VideoPreparationError('Incomplete playback initialization.')
    const normalized = normalizeVideoInitialization(header)
    if (normalized.changed) await handle.write(normalized.data, 0, initBytes, 0)
  } finally {
    await handle.close()
  }
  const encoded = await probeVideo(output)
  const picture = encoded.streams.find((s) => s.codec_type === 'video')!
  if (
    !picture.width ||
    !picture.height ||
    picture.codec_name !== 'h264' ||
    picture.pix_fmt !== 'yuv420p' ||
    (source.hasAudio &&
      !encoded.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac'))
  )
    throw new VideoPreparationError('Playback track validation failed.')
  const header = await open(output, 'r')
  let codec = ''
  try {
    const bytes = Buffer.alloc(initBytes)
    await header.read(bytes, 0, initBytes, 0)
    const offset = bytes.indexOf(Buffer.from('avcC'))
    if (offset < 0 || offset + 8 > bytes.length)
      throw new VideoPreparationError('Missing AVC configuration.')
    codec = 'avc1.' + bytes.subarray(offset + 5, offset + 8).toString('hex')
  } finally {
    await header.close()
  }
  const segments = [...manifest.matchAll(/#EXTINF:([\d.]+),\n#EXT-X-BYTERANGE:(\d+)@/g)]
  if (!segments.length) throw new VideoPreparationError('Missing segment ranges.')
  const bandwidth = Math.ceil(Math.max(...segments.map((m) => (Number(m[2]) * 8) / Number(m[1]))))
  return {
    output,
    manifest,
    bytes,
    duration,
    bandwidth,
    averageBandwidth: Math.ceil(((bytes - initBytes) * 8) / seconds),
    width: picture.width,
    height: picture.height,
    frameRate: rate,
    codecs: codec + (source.hasAudio ? ',mp4a.40.2' : ''),
  }
}

/** Decode, normalize HDR and frame timing once, then fan out to aligned HLS outputs.
 * No upscaling or duplicate-sized renditions for small source videos.
 * Each encoder uses one thread; the shared decoder/filter graph uses two.
 */
export async function encodeAdaptivePlayback(
  input: string,
  dir: string,
  preset: 'fast' | 'veryfast' = 'veryfast',
  signal?: AbortSignal,
) {
  const source = await probeVideo(input)
  const video = source.streams.find((s) => s.codec_type === 'video')!
  const edge = Math.max(video.width || 0, video.height || 0)
  if (!edge) throw new VideoPreparationError('Missing video dimensions.')
  const plans =
    edge > 1280
      ? [
          { name: '720', edge: 1280, kbps: 3500 },
          { name: '1080', edge: 1920, kbps: 8000 },
        ]
      : [{ name: '720', edge: 1280, kbps: 3500 }]
  const hdr = ['arib-std-b67', 'smpte2084'].includes(video.color_transfer || '')
  const [num, den] = (video.r_frame_rate || '30/1').split('/').map(Number)
  const rate = Number.isFinite(num / den) && num / den > 0 ? Math.min(60, num / den) : 30
  const scale = (n: number) =>
    `scale=w='min(${n},iw)':h='min(${n},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`
  const common = [scale(plans[plans.length - 1].edge)]
  if (hdr)
    common.push(
      'zscale=t=linear:npl=100',
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
    )
  common.push('format=yuv420p', 'setsar=1', `fps=${rate}`)
  const graph =
    plans.length === 1
      ? `[0:v:0]${common.join(',')}[v0]`
      : `[0:v:0]${common.join(',')},split=2[low][v1];[low]${scale(1280)}[v0]`
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-protocol_whitelist',
    'file,pipe',
    '-threads',
    '2',
    '-i',
    input,
    '-filter_complex_threads',
    '2',
    '-filter_complex',
    graph,
  ]
  for (const [i, plan] of plans.entries()) {
    const target = join(dir, plan.name)
    await mkdir(target, { recursive: true })
    args.push(
      '-map',
      `[v${i}]`,
      ...videoAudioMap(source.streams),
      '-sn',
      '-dn',
      '-c:v',
      'libx264',
      '-preset',
      preset,
      '-crf',
      '18',
      '-maxrate',
      `${plan.kbps}k`,
      '-bufsize',
      `${plan.kbps * 2}k`,
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-force_key_frames',
      'expr:gte(t,n_forced*2)',
      '-sc_threshold',
      '0',
      ...(hdr
        ? [
            '-color_primaries',
            'bt709',
            '-color_trc',
            'bt709',
            '-colorspace',
            'bt709',
            '-color_range',
            'tv',
          ]
        : []),
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-map_metadata',
      '-1',
      '-f',
      'hls',
      '-hls_time',
      '6',
      '-hls_playlist_type',
      'vod',
      '-hls_segment_type',
      'fmp4',
      '-hls_flags',
      'single_file+independent_segments',
      '-hls_segment_filename',
      join(target, 'playback.mp4'),
      join(target, 'playlist.m3u8'),
    )
  }
  await run('ffmpeg', args, 2 * 60 * 60 * 1000, signal)
  const results = []
  for (const plan of plans)
    results.push({
      name: plan.name,
      ...(await validatePlaybackRendition(join(dir, plan.name), source, rate)),
    })
  return results
}

/** Full duration, first video/audio tracks; reduced resolution/frame rate, never truncation. */
export async function compressVideoFile(input: string, output: string, signal?: AbortSignal) {
  const before = await probeVideo(input)
  const plan = compressionPlan(before.seconds, before.hasAudio)
  const common = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-protocol_whitelist',
    'file,pipe',
    '-threads',
    '1',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-sn',
    '-dn',
    '-vf',
    `scale=w='min(${plan.edge},iw)':h='min(${plan.edge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=15`,
    '-filter_threads',
    '1',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-threads',
    '2',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    `${plan.videoKbps}k`,
    '-passlogfile',
    `${output}.pass`,
  ]
  await run(
    'ffmpeg',
    [...common, '-pass', '1', '-an', '-f', 'null', '/dev/null'],
    20 * 60 * 1000,
    signal,
  )
  await run(
    'ffmpeg',
    [
      ...common,
      '-pass',
      '2',
      ...videoAudioMap(before.streams),
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-ac',
      '2',
      '-map_metadata',
      '-1',
      '-movflags',
      '+faststart',
      output,
    ],
    20 * 60 * 1000,
    signal,
  )
  const bytes = (await stat(output)).size
  const after = await probeVideo(output)
  if (bytes <= 0 || bytes >= VIDEO_MAX_BYTES)
    throw new VideoPreparationError(
      'The compressed video still exceeds 100 MB. No analysis was run.',
    )
  if (
    !Number.isFinite(after.seconds) ||
    Math.abs(after.seconds - before.seconds) > Math.max(1, before.seconds * 0.01) ||
    (before.hasAudio && !after.hasAudio)
  )
    throw new VideoPreparationError(
      'The compressed copy failed the duration/audio check. No analysis was run.',
    )
  return { bytes, duration: before.seconds, ...plan }
}

/** Decode one frame with bounded CPU and time; never re-encode the original. */
export async function videoPoster(input: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'video-poster-'))
  try {
    const output = join(dir, 'poster.jpg')
    await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-protocol_whitelist',
        'file,pipe',
        '-threads',
        '1',
        '-i',
        input,
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        '-vf',
        'scale=400:400:force_original_aspect_ratio=decrease',
        '-threads',
        '1',
        output,
      ],
      20000,
    )
    return await readFile(output)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
