import { withServiceDatabase } from '../database/database-context'
import type { PlaybackRendition } from './video-playlist'
import { randomUUID } from 'node:crypto'
import { pgQuery, pgQueryOne, pgTransaction } from '../postgres'
import { claimPlaybackJob, failPlaybackJob, renewPlaybackJob } from '../video-playback-queue'
import { preparePlaybackCopy } from './video-compression'
import { flagOn } from '../flags'

export async function getVideoPlayback(photoId: number) {
  if (!flagOn('VIDEO_STREAMING_ENABLED')) return null
  const ready = await pgQueryOne<{
    stage_path: string
    playlist: string
    renditions: PlaybackRendition[]
  }>(
    "SELECT v.stage_path,v.playlist,v.renditions FROM video_playback v JOIN photos p USING(photo_id) WHERE v.photo_id=$1 AND v.status='ready' AND v.format_version=2 AND v.original_path=p.original_stage_path",
    [photoId],
  )
  if (ready) return ready
  // Viewing a video moves its preparation ahead of the library backfill.
  if (flagOn('VIDEO_CONVERSION_ENABLED'))
    await pgQuery(
      "UPDATE video_playback SET requested_at=NOW()-INTERVAL '1 year',status='queued' WHERE photo_id=$1 AND status='queued' AND requested_at>NOW()-INTERVAL '1 day'",
      [photoId],
    )
  return null
}
let pending: Promise<unknown> | null = null
/** Bounded worker entry point; reusable by a dedicated process when capacity is added. */
function processVideoPlaybackService(maxJobs = 1) {
  if (!flagOn('VIDEO_CONVERSION_ENABLED')) return Promise.resolve(null)
  if (pending) return pending
  pending = (async () => {
    const job = await claimPlaybackJob(maxJobs)
    if (!job) return
    const controller = new AbortController()
    let renewing = false
    const heartbeat = setInterval(() => {
      if (renewing) return
      renewing = true
      void renewPlaybackJob(job)
        .then((owned) => {
          if (!owned) controller.abort()
        })
        .catch(() => controller.abort())
        .finally(() => {
          renewing = false
        })
    }, 60000)
    heartbeat.unref()
    try {
      const copy = await preparePlaybackCopy(
        job.original_path,
        Number(job.file_size_bytes),
        randomUUID(),
        controller.signal,
      )
      controller.signal.throwIfAborted()
      await pgTransaction(async () => {
        // Match upload/delete lock order: photo first, then its playback row.
        const live = await pgQueryOne(
          'SELECT photo_id FROM photos WHERE photo_id=$1 AND original_stage_path=$2 FOR UPDATE',
          [job.photo_id, job.original_path],
        )
        if (!live) throw new Error('Video no longer available')
        const owned = await pgQueryOne(
          "SELECT photo_id FROM video_playback WHERE photo_id=$1 AND claim_token=$2 AND status='running' AND lease_until>NOW() FOR UPDATE",
          [job.photo_id, job.claim_token],
        )
        if (!owned) throw new Error('Playback lease lost')
        await pgQuery('UPDATE photos SET duration=COALESCE(duration,$2) WHERE photo_id=$1', [
          job.photo_id,
          copy.duration,
        ])
        await pgQuery(
          `INSERT INTO stage_cleanup(path,next_attempt) SELECT path,NOW()+INTERVAL '24 hours' FROM (
     SELECT stage_path AS path FROM video_playback WHERE photo_id=$1
     UNION SELECT r->>'stage_path' FROM video_playback CROSS JOIN LATERAL jsonb_array_elements(renditions) r WHERE photo_id=$1
    ) old WHERE path IS NOT NULL ON CONFLICT DO NOTHING`,
          [job.photo_id],
        )
        await pgQuery(
          "UPDATE video_playback SET status='ready',stage_path=$2,playlist=$3,file_bytes=$4,renditions=$5::jsonb,format_version=2,completed_at=NOW(),error=NULL,claim_token=NULL,lease_until=NULL WHERE photo_id=$1",
          [job.photo_id, copy.path, copy.manifest, copy.bytes, JSON.stringify(copy.renditions)],
        )
        await pgQuery('DELETE FROM stage_cleanup WHERE path=ANY($1::text[])', [
          copy.renditions.map((r) => r.stage_path),
        ])
      })
    } catch (error) {
      console.error('[video-playback]', job.photo_id, error)
      await failPlaybackJob(job)
    } finally {
      clearInterval(heartbeat)
    }
  })().finally(() => {
    pending = null
  })
  return pending
}

export function processVideoPlayback(...args: Parameters<typeof processVideoPlaybackService>) {
  return withServiceDatabase(() => processVideoPlaybackService(...args))
}
