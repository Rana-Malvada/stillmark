import { uploadFailureDiagnostic, type UploadProcessingPhase } from '../diagnostic-schema'
import { readUploadChunk } from './upload-chunk-stage'
import { randomUUID } from 'node:crypto'
import { uploadQueuePool } from './upload-queue-database'
import { databaseContext } from '../database/database-context'
import { pgAuthEpoch, pgAuthMainAdmin, pgQuery } from '../postgres'
import { completeUpload } from './upload-sessions'
import { uploadCompletionLimit, withUploadClaimCapacity } from './upload-capacity'
import type { AlbumCaller } from '../albums/album-access'
import { HttpError } from '../http'
import { startUploadDispatcher } from './upload-dispatcher'
import { requireUploadAccountAuthority } from './upload-account-authority'
import {
  confirmQueuedUploadAuthority,
  reauthorizeQueuedUpload,
} from '../identity/queued-upload-authority'

type Job = {
  upload_id: string
  owner: string
  body: Record<string, unknown>
  caller: AlbumCaller
  auth_epoch: string
  lease_token: string
  attempts: number
  created_at: string
  thumbnail?: { path: string; size: number; hash: string } | null
}
import { claimUploadJobSql, retryUploadJob } from './upload-processing-policy'

export async function claimUploadJob(): Promise<Job | undefined> {
  const client = await uploadQueuePool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended('upload-routing-admission',0))",
    )
    const { rows } = await client.query('SELECT route,phase FROM upload_routing WHERE id=true')
    const job =
      rows[0]?.route === 'pool' && rows[0]?.phase === 'pool'
        ? (await client.query(claimUploadJobSql, [randomUUID(), 'pool'])).rows[0]
        : undefined
    await client.query('COMMIT')
    return job
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
export async function processUploadJob(job: Job) {
  let phase: UploadProcessingPhase = 'authorize'
  const lease = new AbortController()
  let renewing = false
  const heartbeat = setInterval(async () => {
    if (renewing) return
    renewing = true
    try {
      const renewed = await uploadQueuePool().query(
        `UPDATE upload_processing_jobs SET lease_until=now()+interval '5 minutes'
      WHERE upload_id=$1 AND lease_token=$2 AND state='processing' AND lease_until>now()`,
        [job.upload_id, job.lease_token],
      )
      if (renewed.rowCount !== 1)
        lease.abort(new HttpError(409, 'Upload processing lease lost; retry upload'))
    } catch {
      lease.abort(new HttpError(503, 'Upload lease renewal failed; retry upload'))
    } finally {
      renewing = false
    }
  }, 30000)
  heartbeat.unref()
  try {
    if (Date.now() - new Date(job.created_at).getTime() > 7 * 24 * 60 * 60 * 1000)
      throw new HttpError(403, 'Queued upload authorization expired; retry after checking access')
    if (job.attempts > 5)
      throw new HttpError(
        422,
        'Processing stopped after repeated worker interruptions; retry this file',
      )
    // An access change for anyone advances the global epoch. The accepted snapshot is
    // then never used: the owner's authority is read again from the permission tables,
    // and publication confirms it once more inside its transaction.
    const epoch = await pgAuthEpoch()
    const current =
      epoch === job.auth_epoch ? undefined : await reauthorizeQueuedUpload(job.owner, lease.signal)
    const c: AlbumCaller = current ?? {
      ...job.caller,
      mainAdmin:
        (job.caller.appOwner === true || (await pgAuthMainAdmin(job.owner))) &&
        job.caller.role !== 'admin_readonly',
    }
    if (
      c.username !== job.owner ||
      c.canManagePersonal === false ||
      (c.role === 'admin_readonly' && !c.canManagePersonal)
    )
      throw new HttpError(403, 'Upload permission denied')
    await databaseContext.run(
      {
        kind: 'request',
        signal: lease.signal,
        identity: Promise.resolve({
          username: c.username,
          mainAdmin: c.mainAdmin,
          adminRead: c.role !== 'viewer',
          adminWrite: c.role === 'admin',
          canWrite: true,
          accessManager: false,
        }),
      },
      async () => {
        // A queued delegation must not outlive account disablement/deletion.
        // Publication checks again under the transaction's account fence.
        await requireUploadAccountAuthority(job.owner)
        phase = 'renew-session'
        await pgQuery(
          "UPDATE upload_sessions SET expires_at=GREATEST(expires_at,now()+interval '1 hour') WHERE upload_id=$1 AND owner=$2",
          [job.upload_id, job.owner],
        )
        lease.signal.throwIfAborted()
        phase = 'read-thumbnail'
        const thumbnail = job.thumbnail
          ? (
              await readUploadChunk(job.thumbnail.path, job.thumbnail.size, job.thumbnail.hash)
            ).toString('base64')
          : undefined
        lease.signal.throwIfAborted()
        phase = 'complete'
        await completeUpload(
          job.owner,
          { ...job.body, ...(thumbnail ? { thumbnail } : {}) },
          c,
          job.lease_token,
          ...(current ? [() => confirmQueuedUploadAuthority(job, current, epoch)] : []),
        )
      },
    )
    phase = 'acknowledge'
    // Also closes a replay where the catalog was already committed by an older synchronous client.
    await uploadQueuePool().query(
      "UPDATE upload_processing_jobs SET state='done',lease_token=NULL,lease_until=NULL,error=NULL,updated_at=now() WHERE upload_id=$1 AND lease_token=$2",
      [job.upload_id, job.lease_token],
    )
  } catch (error) {
    const retry = retryUploadJob(error, job.attempts)
    try {
      console.error(
        '[upload-queue]',
        uploadFailureDiagnostic(error, {
          uploadId: job.upload_id,
          attempt: job.attempts,
          phase,
          retry,
        }),
      )
    } catch {
      // Diagnostics must never prevent durable retry or claim release.
    }
    await uploadQueuePool().query(
      `UPDATE upload_processing_jobs SET state=$3,error=$4,
      next_attempt=now()+($5*interval '1 second'),lease_token=NULL,lease_until=NULL,updated_at=now()
      WHERE upload_id=$1 AND lease_token=$2`,
      [
        job.upload_id,
        job.lease_token,
        retry ? 'queued' : 'failed',
        error instanceof HttpError
          ? error.message
          : 'Processing failed; retry this file if automatic recovery does not complete',
        Math.min(300, 5 * 2 ** job.attempts) * (0.75 + Math.random() * 0.5),
      ],
    )
  } finally {
    clearInterval(heartbeat)
  }
}
let started = false
/** One idle poll per replica; busy claims are bounded independently of CPU slots.
 * SIGTERM stops new claims, leaving in-flight work to finish or its lease to expire. */
export function startUploadProcessingWorker() {
  if (started || process.env.UPLOAD_SERVICE_ONLY !== 'true') return
  const slots = uploadCompletionLimit()
  const dispatcher = startUploadDispatcher({
    slots,
    maxClaims: 2,
    startDelayMs: 1000 + Math.random() * 1000,
    idleDelayMs: () => 2000 + Math.random() * 1000,
    onError: () => console.error('[upload-queue] Worker iteration failed; will retry'),
    runOne: (claimed) =>
      withUploadClaimCapacity(
        () => claimUploadJob(),
        async (job) => {
          claimed()
          const diagnostic = process.env.UPLOAD_QUEUE_DIAGNOSTICS === 'true'
          if (diagnostic)
            process.stdout.write(
              '[upload-queue-test] ' +
                JSON.stringify({
                  event: 'claimed',
                  uploadId: job.upload_id,
                  attempt: job.attempts,
                  executor: 'pool',
                }) +
                '\n',
            )
          await processUploadJob(job)
          if (diagnostic)
            process.stdout.write(
              '[upload-queue-test] ' +
                JSON.stringify({
                  event: 'finished',
                  uploadId: job.upload_id,
                  executor: 'pool',
                }) +
                '\n',
            )
        },
      ),
  })
  started = true
  process.once('SIGTERM', dispatcher.stop)
  process.once('SIGINT', dispatcher.stop)
}
