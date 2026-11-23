import { randomUUID } from 'node:crypto'
import { pgQuery, pgQueryOne, pgTransaction } from './postgres'

export type PlaybackJob = {
  photo_id: number
  original_path: string
  file_size_bytes: string
  claim_token: string
}
/** Serialize admission briefly, never the encoding. A global cap protects today's shared runtime. */
export async function claimPlaybackJob(
  maxJobs = 1,
  yieldToAnalysis = true,
  runId: string | null = null,
): Promise<PlaybackJob | null> {
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 32)
    throw new Error('Invalid playback concurrency')
  return pgTransaction(async () => {
    await pgQuery("SELECT pg_advisory_xact_lock(hashtextextended('video-playback-admission',0))")
    await pgQuery(`UPDATE video_playback SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,
   claim_token=NULL,lease_until=NULL,next_attempt_at=NOW()+INTERVAL '1 minute',error='Preparation interrupted'
   WHERE status='running' AND lease_until<NOW()`)
    const count = await pgQueryOne<{ n: number }>(
      "SELECT count(*)::int n FROM video_playback WHERE status='running'",
    )
    if ((count?.n || 0) >= maxJobs) return null
    // Explicit AI requests keep priority on the current shared runtime.
    if (
      yieldToAnalysis &&
      (await pgQueryOne("SELECT 1 FROM video_analyses WHERE status='running' LIMIT 1"))
    )
      return null
    return pgQueryOne<PlaybackJob>(
      `WITH candidate AS (
   SELECT v.photo_id,p.file_size_bytes FROM video_playback v JOIN photos p USING(photo_id)
   WHERE ($2::uuid IS NULL OR v.preparation_run_id=$2) AND v.status='queued' AND v.next_attempt_at<=NOW() AND p.ingest_status='READY' AND p.original_stage_path=v.original_path
   ORDER BY v.requested_at,v.photo_id DESC FOR UPDATE OF v SKIP LOCKED LIMIT 1
  ) UPDATE video_playback v SET status='running',claim_token=$1,attempts=attempts+1,lease_until=NOW()+INTERVAL '5 minutes'
   FROM candidate c WHERE v.photo_id=c.photo_id RETURNING v.photo_id,v.original_path,c.file_size_bytes,v.claim_token`,
      [randomUUID(), runId],
    )
  })
}
export async function renewPlaybackJob(job: PlaybackJob) {
  return !!(await pgQueryOne(
    `UPDATE video_playback SET lease_until=NOW()+INTERVAL '5 minutes'
 WHERE photo_id=$1 AND claim_token=$2 AND status='running' AND lease_until>NOW() RETURNING photo_id`,
    [job.photo_id, job.claim_token],
  ))
}
export async function failPlaybackJob(
  job: PlaybackJob,
  detail = 'Streaming preparation failed; original playback remains available.',
) {
  await pgQuery(
    `UPDATE video_playback SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,
 next_attempt_at=NOW()+CASE WHEN attempts=1 THEN INTERVAL '10 seconds' ELSE INTERVAL '30 seconds' END,claim_token=NULL,lease_until=NULL,error=$3
 WHERE photo_id=$1 AND claim_token=$2 AND status='running'`,
    [job.photo_id, job.claim_token, detail.slice(0, 1000)],
  )
}
