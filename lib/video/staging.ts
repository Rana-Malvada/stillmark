import { mkdtemp, readdir, rm, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { downloadVideoOriginal } from './video-original-download'
import { VideoPreparationError } from './video-preparation-error'
import { putFileToStage } from '../snowflake/stage-upload'
import { pgQuery } from '../postgres'
import { querySnowflakeStorage } from '../snowflake'
import { STAGE } from '../snowflake/storage-constants'
import { VIDEO_MAX_BYTES } from './video-analysis-format'
import { compressVideoFile, encodeAdaptivePlayback, remuxVideoFile } from './transforms'

export async function preparePlaybackCopy(
  original: string,
  expectedBytes: number,
  id: string,
  signal?: AbortSignal,
) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid playback job')
  const disk = await statfs(tmpdir())
  if (
    expectedBytes <= 0 ||
    expectedBytes > 4 * 1024 ** 3 ||
    disk.bavail * disk.bsize < expectedBytes * 2 + 512 * 1024 ** 2
  )
    throw new VideoPreparationError('Insufficient temporary disk for streaming preparation.')
  const dir = await mkdtemp(join(tmpdir(), 'photo-video-playback-'))
  try {
    const input = join(dir, 'original')
    await downloadVideoOriginal(original, input, expectedBytes, {
      timeoutMs: 20 * 60 * 1000,
      signal,
      messages: {
        unreadable: 'The original could not be read.',
        changed: 'Original size changed.',
        incomplete: 'Original download was incomplete.',
      },
    })
    const renditions = []
    let totalBytes = 0
    let duration = 0
    for (const result of await encodeAdaptivePlayback(input, dir, 'veryfast', signal)) {
      const name = result.name
      duration = result.duration
      const stage_path = `display/video/${id}/${name}/playback.mp4`
      signal?.throwIfAborted()
      // putFileToStage registers durable cleanup before uploading.
      await putFileToStage(result.output, stage_path)
      totalBytes += result.bytes
      renditions.push({
        name,
        stage_path,
        playlist: result.manifest,
        bandwidth: result.bandwidth,
        averageBandwidth: result.averageBandwidth,
        width: result.width,
        height: result.height,
        frameRate: result.frameRate,
        codecs: result.codecs,
      })
    }
    return {
      path: renditions[0].stage_path,
      manifest: renditions[0].playlist,
      bytes: totalBytes,
      renditions,
      duration,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function removeAnalysisCopy(path: string) {
  if (!/^analysis-temp\/[a-f0-9-]{36}\/analysis\.mp4$/.test(path))
    throw new Error('Invalid temporary analysis path')
  // Durable retry intent remains if deletion fails.
  await pgQuery('UPDATE stage_cleanup SET next_attempt=NOW() WHERE path=$1', [path])
  try {
    const pattern = path.replace(/\./g, '\\.').replace(/\\/g, '\\\\')
    await querySnowflakeStorage(`REMOVE '${STAGE}/${path}' PATTERN='(^|.*/)${pattern}$'`)
    await pgQuery('DELETE FROM stage_cleanup WHERE path=$1', [path])
  } catch (error) {
    console.error('[video-copy-cleanup]', error)
  }
}

export async function cleanupLocalAnalysisCopies() {
  for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('photo-video-analysis-')) continue
    const path = join(tmpdir(), entry.name)
    if (Date.now() - (await stat(path)).mtimeMs > 2 * 60 * 60 * 1000)
      await rm(path, { recursive: true, force: true })
  }
}

/** Stream original to temporary disk, never PostgreSQL or an in-memory file buffer. */
export async function prepareAnalysisCopy(
  original: string,
  expectedBytes: number,
  id: string,
  remuxOnly = false,
  signal?: AbortSignal,
) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid job id')
  const disk = await statfs(tmpdir())
  if (expectedBytes > 4 * 1024 ** 3 || disk.bavail * disk.bsize < expectedBytes + 1024 ** 3)
    throw new VideoPreparationError(
      'Not enough temporary disk space to prepare this video. The original is unchanged.',
    )
  const dir = await mkdtemp(join(tmpdir(), 'photo-video-analysis-'))
  const path = `analysis-temp/${id}/analysis.mp4`
  try {
    const input = join(dir, 'input')
    const output = join(dir, 'analysis.mp4')
    await downloadVideoOriginal(original, input, expectedBytes, {
      timeoutMs: 10 * 60 * 1000,
      signal,
      messages: {
        unreadable: 'The original video could not be read.',
        changed: 'The original video size changed.',
        incomplete: 'The original video download was incomplete.',
      },
    })
    const info = remuxOnly
      ? await remuxVideoFile(input, output, signal)
      : await compressVideoFile(input, output, signal)
    if (info.bytes >= VIDEO_MAX_BYTES)
      throw new VideoPreparationError('Prepared video exceeds the analysis size limit.')
    signal?.throwIfAborted()
    await putFileToStage(output, path)
    signal?.throwIfAborted()
    return { path, ...info }
  } catch (error) {
    await removeAnalysisCopy(path)
    throw error
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
