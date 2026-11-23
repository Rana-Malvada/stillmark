import { randomUUID } from 'node:crypto'
import { pgQuery, pgQueryOne, pgTransaction } from '../postgres'
import { HttpError } from '../http'
import { requireUploadAccountAuthority } from './upload-account-authority'

/** Row-level lease ownership works across replicas; memory admission is per instance. */
export async function claimUploadCompletion(id: string, owner: string, queuedToken?: string) {
  return pgTransaction(async () => {
    await requireUploadAccountAuthority(owner)
    const job = await pgQueryOne<{ lease_token: string | null; state: string; active: boolean }>(
      'SELECT lease_token,state,lease_until>NOW() AS active FROM upload_processing_jobs WHERE upload_id=$1 AND owner=$2 FOR UPDATE',
      [id, owner],
    )
    if (job && job.state !== 'done' && (!queuedToken || job.lease_token !== queuedToken))
      throw new HttpError(429, 'This upload is queued for processing; check its status', 5)
    if (
      queuedToken &&
      (!job || job.state !== 'processing' || !job.active || job.lease_token !== queuedToken)
    )
      throw new HttpError(409, 'Upload job claim expired')
    const session = await pgQueryOne<{
      result: Record<string, unknown> | null
      active: boolean
      completion_token: string | null
    }>(
      `SELECT result,completion_token,
   completion_lease_until>NOW() AS active FROM upload_sessions WHERE upload_id=$1 AND owner=$2 AND expires_at>NOW() FOR UPDATE`,
      [id, owner],
    )
    if (!session) throw new HttpError(404, 'Upload expired or not found')
    if (session.result) return { result: session.result, token: null }
    // A replacement queue lease fences its predecessor at publication. It must
    // also replace the predecessor's completion lease, rather than burn retries
    // waiting for that independent five-minute timer. The same worker attempt
    // still cannot claim an active completion twice.
    if (session.active && (!queuedToken || session.completion_token === queuedToken))
      throw new HttpError(429, 'This upload is processing; retry shortly', 2)
    const token = queuedToken ?? randomUUID()
    await pgQuery(
      "UPDATE upload_sessions SET completion_token=$2,completion_lease_until=NOW()+INTERVAL '5 minutes',expires_at=GREATEST(expires_at,NOW()+INTERVAL '1 hour') WHERE upload_id=$1",
      [id, token],
    )
    return { result: null, token }
  })
}
export async function renewUploadCompletion(id: string, token: string) {
  return !!(await pgQueryOne(
    `UPDATE upload_sessions SET completion_lease_until=NOW()+INTERVAL '5 minutes',
  expires_at=GREATEST(expires_at,NOW()+INTERVAL '1 hour') WHERE upload_id=$1 AND completion_token=$2
  AND completion_lease_until>NOW() AND result IS NULL RETURNING upload_id`,
    [id, token],
  ))
}
export async function publishUploadCompletion<T>(
  id: string,
  owner: string,
  token: string,
  fn: () => Promise<T>,
  queuedToken?: string,
  confirmAuthority?: () => Promise<void>,
): Promise<T> {
  return pgTransaction(async () => {
    // Account fence -> queue -> session -> catalog, matching deletion/enqueue.
    await requireUploadAccountAuthority(owner)
    if (queuedToken) {
      // A job re-authorized after an access change proves its owner's live authority
      // in this transaction, then meets the same epoch fence as every other job.
      await confirmAuthority?.()
      const job = await pgQueryOne(
        `SELECT upload_id FROM upload_processing_jobs
        WHERE upload_id=$1 AND owner=$2 AND state='processing' AND lease_token=$3
        AND lease_until>NOW() AND auth_epoch=photo_security.authorization_epoch()::text FOR UPDATE`,
        [id, owner, queuedToken],
      )
      if (!job) throw new HttpError(409, 'Upload job claim expired')
    }
    const session = await pgQueryOne(
      `SELECT upload_id FROM upload_sessions WHERE upload_id=$1 AND owner=$2
   AND completion_token=$3 AND completion_lease_until>NOW() AND result IS NULL FOR UPDATE`,
      [id, owner, token],
    )
    if (!session) throw new HttpError(409, 'Upload processing claim expired; retry upload')
    const result = await fn()
    await pgQuery(
      'UPDATE upload_sessions SET result=$2::jsonb,completion_token=NULL,completion_lease_until=NULL WHERE upload_id=$1',
      [id, JSON.stringify(result)],
    )
    await pgQuery(
      'UPDATE stage_cleanup SET next_attempt=NOW() WHERE path IN (SELECT stage_path FROM upload_chunks WHERE upload_id=$1)',
      [id],
    )
    await pgQuery('DELETE FROM upload_chunks WHERE upload_id=$1', [id])
    if (queuedToken) {
      const { recordAction } = await import('../observability/user-activity')
      const stored = await pgQueryOne<{ bytes: string }>(
        'SELECT bytes FROM upload_sessions WHERE upload_id=$1',
        [id],
      )
      const outcome = result as { successCount?: number; skippedCount?: number }
      await recordAction(
        owner,
        'upload_completed',
        `upload:${id}`,
        {
          bytes: Number(stored?.bytes ?? 0),
          files: 1,
          outcome: outcome.successCount ? 'success' : outcome.skippedCount ? 'skipped' : 'unknown',
        },
        id,
      )
    }
    if (queuedToken)
      await pgQuery(
        "UPDATE upload_processing_jobs SET state='done',lease_token=NULL,lease_until=NULL,error=NULL,updated_at=NOW() WHERE upload_id=$1 AND lease_token=$2",
        [id, queuedToken],
      )
    return result
  })
}
export async function releaseUploadCompletion(id: string, token: string) {
  await pgQuery(
    'UPDATE upload_sessions SET completion_token=NULL,completion_lease_until=NULL WHERE upload_id=$1 AND completion_token=$2',
    [id, token],
  )
}
