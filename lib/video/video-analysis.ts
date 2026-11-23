import { objects } from '../../config/deployment.mjs'
import { withServiceDatabase } from '../database/database-context'
import { preparedAnalysisSource } from './video-analysis-source'
import { randomUUID } from 'node:crypto'
import { pgQuery, pgQueryOne, pgTransaction, withAdvisoryLock } from '../postgres'
import { requireAdmin } from '../identity/auth'
import { accessibleAlbumIds, albumMutation, requirePhotoAccess } from '../albums/album-access'
import { HttpError } from '../http'
import { querySnowflakeLongRunning } from '../snowflake'
import { costWork } from '../costs/cost-work'
import {
  parseVideoResult,
  VIDEO_MAX_BYTES,
  VIDEO_MODEL,
  VIDEO_PROMPT,
  VIDEO_PROMPT_VERSION,
  VIDEO_SCHEMA,
  videoEligibility,
  videoSearchText,
} from './video-analysis-format'

import {
  cleanupLocalAnalysisCopies,
  prepareAnalysisCopy,
  removeAnalysisCopy,
  VideoPreparationError,
} from './video-compression'

type Video = {
  photo_id: number
  media_type: string
  ingest_status: string
  original_stage_path: string | null
  file_size_bytes: string
  owner_username: string
}
export async function requestVideoAnalysis(photoId: number, rerun = false) {
  const admin = await requireAdmin()
  return albumMutation(async (c) => {
    await requirePhotoAccess(photoId, false, c)
    const p = await pgQueryOne<Video>(
      'SELECT p.*,e.owner_username FROM photos p JOIN events e USING(event_id) WHERE photo_id=$1',
      [photoId],
    )
    if (!p) throw new HttpError(404, 'Video not found')
    const reason = videoEligibility(p)
    if (reason) throw new HttpError(400, reason)
    const active = await pgQueryOne(
      "SELECT id,status FROM video_analyses WHERE photo_id=$1 AND status IN ('queued','running')",
      [photoId],
    )
    if (active) return active
    if (
      !rerun &&
      (await pgQueryOne("SELECT id FROM video_analyses WHERE photo_id=$1 AND status='completed'", [
        photoId,
      ]))
    )
      throw new HttpError(409, 'Analysis already exists. Choose Run again to replace it.')
    // Serialize explicit requests with album mutations; cap the manual queue.
    const count = await pgQueryOne<{ n: number }>(
      'SELECT photo_security.analysis_queue_count()::int AS n',
    )
    if ((count?.n ?? 0) >= 10)
      throw new HttpError(429, 'The analysis queue is full. Wait for a video to finish.')
    return (
      await pgQuery(
        `INSERT INTO video_analyses(id,photo_id,requested_by,owner_username,model,prompt_version,status)
   VALUES($1,$2,$3,$4,$5,$6,'queued') RETURNING id,status`,
        [
          randomUUID(),
          photoId,
          admin.username,
          p.owner_username,
          VIDEO_MODEL,
          VIDEO_PROMPT_VERSION,
        ],
      )
    )[0]
  })
}
export async function getVideoAnalysis(photoId: number) {
  const access = await requirePhotoAccess(photoId)
  const p = await pgQueryOne<Video>('SELECT * FROM photos WHERE photo_id=$1', [photoId])
  if (!p || p.media_type !== 'video') throw new HttpError(404, 'Video not found')
  const rows = await pgQuery(
    `SELECT id,status,model,prompt_version,created_at,started_at,completed_at,result,error,phase,compressed,analysis_bytes FROM video_analyses WHERE photo_id=$1 ORDER BY created_at DESC LIMIT 20`,
    [photoId],
  )
  const completed = await pgQueryOne(
    "SELECT id,status,model,prompt_version,created_at,started_at,completed_at,result,compressed,analysis_bytes FROM video_analyses WHERE photo_id=$1 AND status='completed' ORDER BY created_at DESC LIMIT 1",
    [photoId],
  )
  const canRun = access.caller.role === 'admin'
  return {
    canRun,
    unavailable: videoEligibility(p),
    latest: rows[0] ?? null,
    completed,
    history: canRun ? rows.map(({ result, ...r }) => r) : undefined,
  }
}
export async function listAnalysisVideos(query: string, page: number) {
  await requireAdmin()
  const ids = await accessibleAlbumIds()
  const rows = await pgQuery(
    `SELECT p.photo_id,p.source_filename,p.file_size_bytes,e.event_name,e.event_id,
  (SELECT status FROM video_analyses a WHERE a.photo_id=p.photo_id ORDER BY created_at DESC LIMIT 1) AS status
 FROM photos p JOIN events e USING(event_id) WHERE p.media_type='video' AND p.ingest_status='READY' AND p.event_id=ANY($1::int[])
 AND ($2='' OR p.source_filename ILIKE '%'||$2||'%' OR e.event_name ILIKE '%'||$2||'%')
 ORDER BY p.photo_id DESC LIMIT 51 OFFSET $3`,
    [ids, query, page * 50],
  )
  return { videos: rows.slice(0, 50), hasMore: rows.length > 50 }
}
let pending: Promise<unknown> | null = null
/** Only explicitly queued rows run. A timeout/restart requires a fresh admin request. */
function processVideoAnalysesService(): Promise<unknown> {
  if (pending) return pending
  pending = withAdvisoryLock('video-analysis', async () => {
    await cleanupLocalAnalysisCopies()
    await pgQuery(
      "UPDATE video_analyses SET status='failed',error='Analysis was interrupted. An administrator can run it again.',completed_at=NOW() WHERE status='running' AND lease_until<NOW()",
    )
    await pgQuery(
      'DELETE FROM video_analyses a WHERE NOT EXISTS(SELECT 1 FROM photos p WHERE p.photo_id=a.photo_id) AND NOT EXISTS(SELECT 1 FROM photo_trash t WHERE t.photo_id=a.photo_id)',
    )
    const claimToken = randomUUID()
    const controller = new AbortController()
    const job = await pgQueryOne<{ id: string; photo_id: number; owner_username: string }>(
      `UPDATE video_analyses SET status='running',phase='preparing',started_at=NOW(),lease_until=NOW()+INTERVAL '12 minutes',claim_token=$1
   WHERE id=(SELECT id FROM video_analyses WHERE status='queued' AND NOT EXISTS(SELECT 1 FROM video_analyses WHERE status='running') ORDER BY created_at LIMIT 1) RETURNING id,photo_id,owner_username`,
      [claimToken],
    )
    if (!job) return
    let copyPath: string | null = null
    let renewing = false
    async function verifyClaim() {
      const valid = await pgQueryOne(
        "UPDATE video_analyses SET lease_until=NOW()+INTERVAL '12 minutes' WHERE id=$1 AND claim_token=$2 AND status='running' AND lease_until>NOW() RETURNING id",
        [job!.id, claimToken],
      )
      if (!valid) throw new Error('Video analysis claim lost')
      controller.signal.throwIfAborted()
    }
    const heartbeat = setInterval(async () => {
      if (renewing) return
      renewing = true
      try {
        await verifyClaim()
      } catch {
        controller.abort()
      } finally {
        renewing = false
      }
    }, 30000)
    heartbeat.unref()
    try {
      const p = await pgQueryOne<Video>('SELECT * FROM photos WHERE photo_id=$1', [job.photo_id])
      const reason = p ? videoEligibility(p) : 'Video is no longer available.'
      if (reason) throw new Error(reason)
      let analysisPath = p!.original_stage_path!
      let bytes = Number(p!.file_size_bytes)
      const prepared = await preparedAnalysisSource(job.photo_id, analysisPath)
      if (prepared) {
        try {
          // Convert the streaming container to ordinary MP4 without re-encoding.
          const copy = await prepareAnalysisCopy(
            prepared.path,
            prepared.bytes,
            job.id,
            true,
            controller.signal,
          )
          copyPath = copy.path
          analysisPath = copy.path
          bytes = copy.bytes
        } catch (error) {
          console.error('[video-analysis-prepared-fallback]', job.id, error)
        }
      }
      controller.signal.throwIfAborted()
      if (bytes >= VIDEO_MAX_BYTES) {
        const copy = await prepareAnalysisCopy(
          analysisPath,
          bytes,
          job.id,
          false,
          controller.signal,
        )
        copyPath = copy.path
        analysisPath = copy.path
        bytes = copy.bytes
      }
      await verifyClaim()
      await pgQuery(
        "UPDATE video_analyses SET phase='analyzing',compressed=$2,analysis_bytes=$3 WHERE id=$1 AND claim_token=$4 AND status='running'",
        [job.id, !!copyPath, bytes, claimToken],
      )
      const rows = await costWork('video_ai', { [job.owner_username]: 1 }, () =>
        querySnowflakeLongRunning(
          `SELECT /* personal-photos:video_ai */ AI_COMPLETE(?, ?, TO_FILE('@${objects.originals}', ?), {'max_tokens':16384}, PARSE_JSON(?)) AS RESULT`,
          {
            binds: [VIDEO_MODEL, VIDEO_PROMPT, analysisPath, JSON.stringify(VIDEO_SCHEMA)],
            maxWaitMs: 600000,
            pollIntervalMs: 3000,
            signal: controller.signal,
          },
        ),
      )
      const result = parseVideoResult(rows[0]?.RESULT)
      controller.signal.throwIfAborted()
      await pgTransaction(async () => {
        if (
          !(await pgQueryOne(
            "SELECT id FROM video_analyses WHERE id=$1 AND claim_token=$2 AND status='running' AND lease_until>NOW() FOR UPDATE",
            [job.id, claimToken],
          ))
        )
          throw new Error('Video analysis claim lost')
        await pgQuery(
          "UPDATE video_analyses SET status='completed',result=$2::jsonb,search_text=$3,completed_at=NOW(),lease_until=NULL WHERE id=$1 AND claim_token=$4 AND status='running'",
          [job.id, JSON.stringify(result), videoSearchText(result), claimToken],
        )
        // Refresh keyword search and enqueue for the next manual Cortex Sync Search.
        await pgQuery('UPDATE photos SET updated_at=NOW() WHERE photo_id=$1', [job.photo_id])
      })
    } catch (error) {
      console.error('[video-analysis]', job.id, error)
      await pgQuery(
        "UPDATE video_analyses SET status='failed',error=$2,completed_at=NOW(),lease_until=NULL WHERE id=$1 AND claim_token=$3 AND status='running'",
        [
          job.id,
          error instanceof VideoPreparationError
            ? error.message
            : 'Analysis could not finish. The video may be unsupported or the model unavailable. An administrator can run it again.',
          claimToken,
        ],
      )
    } finally {
      clearInterval(heartbeat)
      if (copyPath) await removeAnalysisCopy(copyPath)
    }
  }).finally(() => {
    pending = null
  })
  return pending
}

export function processVideoAnalyses(...args: Parameters<typeof processVideoAnalysesService>) {
  return withServiceDatabase(() => processVideoAnalysesService(...args))
}
