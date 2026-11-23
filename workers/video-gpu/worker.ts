import { videoAudioMap } from '../../lib/video-audio'
import { recordPreparationFailure } from './recovery'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, open, readFile, rm, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { claimPlaybackJob, failPlaybackJob, renewPlaybackJob } from '../../lib/video-playback-queue'
import { pgQuery, pgQueryOne, pgTransaction } from '../../lib/postgres'
import { normalizeVideoInitialization } from '../../lib/video-fragments'
import { compatibleVideoTrack, gpuPlan, safeOriginal } from './plan'

const concurrency = Number(process.env.WORKER_CONCURRENCY || 2)
const maxJobs = Number(process.env.WORKER_MAX_JOBS || 3)
if (
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 8 ||
  !Number.isInteger(maxJobs) ||
  maxJobs < 1 ||
  maxJobs > 10000
)
  throw Error('Invalid worker bounds')
const maxSeconds = Number(process.env.WORKER_MAX_SECONDS || 7200)
if (!Number.isInteger(maxSeconds) || maxSeconds < 60 || maxSeconds > 14400)
  throw Error('Invalid runtime bound')
const runId = process.env.WORKER_RUN_ID || null
if (runId && !/^[a-f0-9-]{36}$/.test(runId)) throw Error('Invalid run ID')
let deadline = Date.now() + maxSeconds * 1000
let started = 0
let completed = 0
let failed = 0
let stopping = false
const controllers = new Set<AbortController>()
let infrastructureError: unknown
function interruptForFailure(error: unknown) {
  infrastructureError ??= error
  stopping = true
  for (const controller of controllers) controller.abort()
}
for (const event of ['SIGTERM', 'SIGINT'] as const)
  process.on(event, () => {
    interruptForFailure(
      Object.assign(new Error('Worker process interrupted'), { code: 'WORKER_TERMINATED' }),
    )
  })
function run(
  binary: string,
  args: string[],
  signal?: AbortSignal,
  timeout = 1800000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/lib/jellyfin-ffmpeg/' + binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const abort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(abort, timeout)
    child.stdout.on('data', (b) => {
      if (out.length < 2000000) out += b
    })
    child.stderr.on('data', (b) => {
      err = (err + b.toString()).slice(-3000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (code === 0 && !signal?.aborted) resolve(out)
      else reject(Error(`${binary} failed (${code}): ${err}`))
    })
  })
}
async function probe(path: string, signal?: AbortSignal) {
  return JSON.parse(
    await run(
      'ffprobe',
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        path,
      ],
      signal,
      30000,
    ),
  )
}
async function upload(file: string, output: string, signal: AbortSignal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await pipeline(createReadStream(file), createWriteStream(output), { signal })
      return
    } catch (error) {
      if (signal.aborted || attempt === 2) throw error
      await rm(output, { force: true }).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
}
async function prepare(job: any, signal: AbortSignal) {
  const path = safeOriginal(job.original_path)
  const size = Number(job.file_size_bytes)
  const disk = await statfs('/tmp')
  if (size <= 0 || size > 16 * 1024 ** 3 || disk.bavail * disk.bsize < size * 2 + 1024 ** 3)
    throw Error('Insufficient scratch space')
  const dir = await mkdtemp('/tmp/playback-')
  const id = randomUUID()
  try {
    const input = join(dir, 'original')
    await copyFile(join('/input', path), input)
    if ((await stat(input)).size !== size) throw Error('Original size mismatch')
    signal.throwIfAborted()
    const source = await probe(input, signal)
    const v = source.streams.find((s: any) => s.codec_type === 'video')
    if (!v) throw Error('No video stream')
    const duration = Number(v.duration) || Number(source.format.duration)
    if (!Number.isFinite(duration) || duration <= 0) throw Error('Invalid duration')
    const hasAudio = source.streams.some((s: any) => s.codec_type === 'audio')
    const plan = gpuPlan(v)
    const args = [
      '-hide_banner',
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-protocol_whitelist',
      'file,pipe',
      '-noautorotate',
      '-display_rotation',
      '0',
      '-hwaccel',
      'cuda',
      '-hwaccel_output_format',
      'cuda',
      '-i',
      input,
      '-filter_complex_threads',
      '2',
      '-filter_complex',
      plan.graph,
    ]
    for (const [i, p] of plan.plans.entries()) {
      const target = join(dir, p.name)
      await mkdir(target)
      args.push(
        '-map',
        `[v${i}]`,
        ...videoAudioMap(source.streams),
        '-sn',
        '-dn',
        '-c:v',
        'h264_nvenc',
        '-preset',
        'p5',
        '-forced-idr',
        '1',
        '-g',
        String(Math.ceil(plan.rate * 2)),
        '-rc',
        'vbr',
        '-cq',
        '18',
        '-b:v',
        '0',
        '-maxrate',
        `${p.kbps}k`,
        '-bufsize',
        `${p.kbps * 2}k`,
        '-force_key_frames',
        'expr:gte(t,n_forced*2)',
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
        ...(plan.hdr
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
    await run('ffmpeg', args, signal)
    const renditions = []
    let bytes = 0
    for (const p of plan.plans) {
      const file = join(dir, p.name, 'playback.mp4')
      const manifest = await readFile(join(dir, p.name, 'playlist.m3u8'), 'utf8')
      const length = (await stat(file)).size
      const seconds = [...manifest.matchAll(/#EXTINF:([\d.]+),/g)].reduce(
        (n, m) => n + Number(m[1]),
        0,
      )
      if (
        !length ||
        Math.abs(seconds - duration) > Math.max(0.5, duration * 0.002) ||
        !manifest.includes('#EXT-X-ENDLIST')
      )
        throw Error('Duration validation failed')
      const init = Number(/BYTERANGE="(\d+)@0"/.exec(manifest)?.[1])
      if (!init || init > 1024 ** 2) throw Error('Invalid init')
      const handle = await open(file, 'r+')
      let codec = ''
      try {
        const header = Buffer.alloc(init)
        if ((await handle.read(header, 0, init, 0)).bytesRead !== init)
          throw Error('Truncated init')
        const fixed = normalizeVideoInitialization(header)
        if (fixed.changed) await handle.write(fixed.data, 0, init, 0)
        const offset = header.indexOf(Buffer.from('avcC'))
        if (offset < 0) throw Error('No AVC header')
        codec = 'avc1.' + header.subarray(offset + 5, offset + 8).toString('hex')
      } finally {
        await handle.close()
      }
      const metadata = await probe(file, signal)
      const picture = metadata.streams.find((s: any) => s.codec_type === 'video')
      if (
        !compatibleVideoTrack(picture) ||
        (hasAudio && !metadata.streams.some((s: any) => s.codec_name === 'aac'))
      )
        throw Error(
          'Track validation failed: ' +
            JSON.stringify({
              source: source.streams.map((s: any) => ({
                type: s.codec_type,
                codec: s.codec_name,
                duration: s.duration,
              })),
              output: metadata.streams.map((s: any) => ({
                type: s.codec_type,
                codec: s.codec_name,
                pix: s.pix_fmt,
                duration: s.duration,
              })),
            }),
        )
      await run(
        'ffmpeg',
        [
          '-v',
          'error',
          '-xerror',
          '-i',
          file,
          '-map',
          '0:v:0',
          '-frames:v',
          '3',
          '-f',
          'null',
          '-',
        ],
        signal,
        30000,
      )
      const segments = [...manifest.matchAll(/#EXTINF:([\d.]+),\n#EXT-X-BYTERANGE:(\d+)@/g)]
      if (!segments.length) throw Error('No segments')
      const stage_path = `display/prepared/${id}/${p.name}/playback.mp4`
      const output = join('/output', id, p.name, 'playback.mp4')
      await pgQuery(
        "INSERT INTO stage_cleanup(path,next_attempt) VALUES($1,NOW()+INTERVAL '24 hours') ON CONFLICT DO NOTHING",
        [stage_path],
      )
      signal.throwIfAborted()
      await mkdir(join('/output', id, p.name), { recursive: true })
      await upload(file, output, signal)
      if ((await stat(output)).size !== length) throw Error('Output size mismatch')
      bytes += length
      renditions.push({
        name: p.name,
        stage_path,
        playlist: manifest,
        bandwidth: Math.ceil(Math.max(...segments.map((m) => (Number(m[2]) * 8) / Number(m[1])))),
        averageBandwidth: Math.ceil(((length - init) * 8) / seconds),
        width: picture.width,
        height: picture.height,
        frameRate: plan.rate,
        codecs: codec + (hasAudio ? ',mp4a.40.2' : ''),
      })
    }
    return { renditions, bytes, duration }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
async function lane() {
  while (!stopping && Date.now() < deadline && started < maxJobs) {
    // Increment before awaiting so all lanes share a strict total-job bound.
    started++
    const job = await claimPlaybackJob(concurrency, false, runId)
    if (!job) {
      started--
      if (runId) {
        const state = await pgQueryOne<{ state: string }>(
          "SELECT photo_security.worker_idle('playback',$1) AS state",
          [runId],
        )
        if (state?.state === 'work' || state?.state === 'idle') {
          await new Promise((resolve) => setTimeout(resolve, state.state === 'work' ? 2000 : 5000))
          continue
        }
      }
      return
    }
    const begin = Date.now()
    const controller = new AbortController()
    controllers.add(controller)
    let renewal: Promise<void> | null = null
    const heartbeat = setInterval(() => {
      if (renewal) return
      renewal = (async () => {
        try {
          if (!(await renewPlaybackJob(job))) controller.abort()
        } catch (error) {
          interruptForFailure(error)
        }
      })().finally(() => {
        renewal = null
      })
    }, 30000)
    try {
      console.log(JSON.stringify({ event: 'started', photo: job.photo_id }))
      const copy = await prepare(job, controller.signal)
      controller.signal.throwIfAborted()
      await pgTransaction(async () => {
        if (
          !(await pgQueryOne(
            'SELECT photo_id FROM photos WHERE photo_id=$1 AND original_stage_path=$2 FOR UPDATE',
            [job.photo_id, job.original_path],
          ))
        )
          throw Error('Original changed or deleted')
        if (
          !(await pgQueryOne(
            "SELECT photo_id FROM video_playback WHERE photo_id=$1 AND claim_token=$2 AND status='running' AND lease_until>NOW() FOR UPDATE",
            [job.photo_id, job.claim_token],
          ))
        )
          throw Error('Lease lost')
        await pgQuery('UPDATE photos SET duration=COALESCE(duration,$2) WHERE photo_id=$1', [
          job.photo_id,
          copy.duration,
        ])
        await pgQuery(
          `INSERT INTO stage_cleanup(path,next_attempt) SELECT path,NOW()+INTERVAL '24 hours' FROM (SELECT stage_path path FROM video_playback WHERE photo_id=$1 UNION SELECT r->>'stage_path' FROM video_playback CROSS JOIN LATERAL jsonb_array_elements(renditions) r WHERE photo_id=$1) old WHERE path IS NOT NULL ON CONFLICT DO NOTHING`,
          [job.photo_id],
        )
        const r = copy.renditions[0]
        await pgQuery(
          "UPDATE video_playback SET status='ready',stage_path=$2,playlist=$3,file_bytes=$4,renditions=$5::jsonb,format_version=2,completed_at=NOW(),error=NULL,claim_token=NULL,lease_until=NULL WHERE photo_id=$1",
          [job.photo_id, r.stage_path, r.playlist, copy.bytes, JSON.stringify(copy.renditions)],
        )
        await pgQuery('DELETE FROM stage_cleanup WHERE path=ANY($1::text[])', [
          copy.renditions.map((r) => r.stage_path),
        ])
      })
      completed++
      console.log(
        JSON.stringify({
          event: 'ready',
          photo: job.photo_id,
          seconds: Math.round((Date.now() - begin) / 1000),
          bytes: copy.bytes,
        }),
      )
    } catch (error) {
      // A lost database heartbeat is infrastructure interruption, not bad media.
      // Keep this claim until expiry; the successor must not race its publication.
      if (infrastructureError) throw infrastructureError
      failed++
      console.error(JSON.stringify({ event: 'failed', photo: job.photo_id, error: String(error) }))
      // Status and diagnostics must be published under the same claim fence.
      await failPlaybackJob(job, String(error))
    } finally {
      clearInterval(heartbeat)
      if (renewal) await renewal
      controllers.delete(controller)
    }
  }
}
async function main() {
  if (runId) {
    const run = await pgQueryOne<{ cycle_deadline: string }>(
      'SELECT cycle_deadline FROM video_preparation_runs WHERE id=$1',
      [runId],
    )
    if (!run) throw Error('Preparation run no longer exists')
    deadline = Math.min(deadline, new Date(run.cycle_deadline).getTime())
  }
  if (runId)
    await pgQuery(
      "UPDATE video_preparation_runs SET status='running',started_at=NOW(),heartbeat_at=NOW(),error=NULL WHERE id=$1 AND status='starting'",
      [runId],
    )
  let pulseQuery: Promise<void> | null = null
  const pulse = runId
    ? setInterval(() => {
        if (pulseQuery) return
        pulseQuery = pgQuery(
          "UPDATE video_preparation_runs SET heartbeat_at=NOW() WHERE id=$1 AND status='running'",
          [runId],
        )
          .then(() => {})
          .catch(interruptForFailure)
          .finally(() => {
            pulseQuery = null
          })
      }, 30000)
    : null
  try {
    // Stop sibling encoders on a failed lane and wait for their cleanup before
    // marking the run interrupted. Never leave publication running after recovery.
    const results = await Promise.allSettled(
      Array.from({ length: concurrency }, async () => {
        try {
          await lane()
        } catch (error) {
          interruptForFailure(error)
          throw error
        }
      }),
    )
    if (pulse) clearInterval(pulse)
    if (pulseQuery) await pulseQuery
    if (infrastructureError) throw infrastructureError
    const rejected = results.find((result) => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
  } finally {
    if (pulse) clearInterval(pulse)
    if (runId)
      await pgQuery(
        "UPDATE video_preparation_runs SET accepting_work=false WHERE id=$1 AND status IN ('starting','running')",
        [runId],
      )
  }
  if (runId)
    await pgQuery(
      `UPDATE video_preparation_runs SET status=CASE WHEN EXISTS(SELECT 1 FROM video_playback WHERE preparation_run_id=$1 AND status<>'ready') THEN 'attention' ELSE 'completed' END,error=CASE WHEN $2 AND EXISTS(SELECT FROM video_playback WHERE preparation_run_id=$1 AND status='queued' AND attempts=0) THEN 'Time budget reached; remaining videos stay queued' ELSE NULL END,finished_at=NOW(),heartbeat_at=NOW() WHERE id=$1 AND status='running'`,
      [runId, !stopping && completed > 0 && (Date.now() >= deadline || started >= maxJobs)],
    )
  console.log(JSON.stringify({ event: 'finished', started, completed, failed }))
  process.exit(failed ? 1 : 0)
}
main().catch(async (error) => {
  console.error(String(error))
  if (runId) await recordPreparationFailure(runId, infrastructureError ?? error).catch(() => {})
  process.exit(1)
})
