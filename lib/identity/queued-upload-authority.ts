import { appPermissionIdentity, type AppPermissionIdentity } from '../app-permissions'
import { databaseContext } from '../database/database-context'
import { HttpError } from '../http'
import { postgresPermissionsEnabled } from '../permission-authority'
import { pgQuery, pgQueryOne } from '../postgres'
import type { CallerIdentity } from './auth'

/** What an upload may do as its owner: the fields a signed-in request would resolve. */
export type QueuedUploadAuthority = {
  username: string
  role: CallerIdentity['role']
  appOwner: boolean
  canManagePersonal: true
  mainAdmin: boolean
}
const changed = () =>
  new HttpError(403, 'Permissions changed; retry this upload after checking access')

/** The owner's authority read from the permission tables now, never from a queued job.
 * It resolves the same row a new sign-in does, so it is never wider than a new request.
 * Deployments whose roles live outside PostgreSQL cannot be re-read here and are refused. */
export async function currentUploadAuthority(owner: string): Promise<QueuedUploadAuthority> {
  if (!postgresPermissionsEnabled()) throw changed()
  const row = await pgQueryOne<AppPermissionIdentity>(
    'SELECT * FROM photo_security.native_app_identity($1)',
    [owner],
  )
  let identity: ReturnType<typeof appPermissionIdentity>
  try {
    identity = appPermissionIdentity(row ?? undefined)
  } catch (error) {
    // Missing, being deleted, disabled or without a gallery role.
    if (error instanceof HttpError) throw changed()
    throw error
  }
  if (identity.username !== owner || identity.canManagePersonal !== true) throw changed()
  return {
    username: owner,
    role: identity.role,
    appOwner: identity.appOwner === true,
    canManagePersonal: true,
    mainAdmin:
      (identity.appOwner === true || identity.mainAdmin === true) &&
      identity.role !== 'admin_readonly',
  }
}

/** Re-authorize a queued upload after the authorization epoch moved. The lookup runs as
 * the owner with no privilege flags; the permission function decides, not this scope. */
export function reauthorizeQueuedUpload(owner: string, signal?: AbortSignal) {
  return databaseContext.run(
    {
      kind: 'request',
      signal,
      identity: Promise.resolve({
        username: owner,
        mainAdmin: false,
        adminRead: false,
        adminWrite: false,
        canWrite: false,
        accessManager: false,
      }),
    },
    () => currentUploadAuthority(owner),
  )
}

/** Inside the publication transaction, before its queue fence: the owner's authority must
 * still be exactly what this attempt used, and the job moves to the epoch that attempt
 * read. A later access change therefore still fails the fence, and a rollback leaves the
 * job on its accepted epoch so the next attempt re-authorizes again. */
export async function confirmQueuedUploadAuthority(
  job: { upload_id: string; owner: string; lease_token: string },
  used: QueuedUploadAuthority,
  epoch: string,
) {
  const now = await currentUploadAuthority(job.owner)
  if (now.role !== used.role || now.appOwner !== used.appOwner || now.mainAdmin !== used.mainAdmin)
    throw new HttpError(409, 'Upload job claim expired')
  const rebound = await pgQuery(
    `UPDATE upload_processing_jobs SET auth_epoch=$4
     WHERE upload_id=$1 AND owner=$2 AND state='processing' AND lease_token=$3
     AND lease_until>NOW() RETURNING upload_id`,
    [job.upload_id, job.owner, job.lease_token, epoch],
  )
  if (rebound.length !== 1) throw new HttpError(409, 'Upload job claim expired')
}
