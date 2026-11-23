import { createHash } from 'node:crypto'
import { storeUploadChunk } from './upload-chunk-stage'
import { requireAlbumAccess, requireUploadUser } from '../albums/album-access'
import { pgAuthEpoch, pgQuery, pgQueryOne, pgTransaction } from '../postgres'
import { freezeUploadMetadata, uploadId } from './upload-sessions'
import { uploadLimit } from './upload-capacity'
import { HttpError } from '../http'
import { CHUNK_BYTES, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_THUMBNAIL_BYTES } from './upload-limits'
import { uploadFileKind } from './upload-file-kind'
import { completionFields } from './upload-completion-fields'
import { requireUploadAccountAuthority } from './upload-account-authority'

/** Accept only fully durable inputs. Authorization is a bounded delegation for
 * this immutable upload, not a browser token retained by the worker. */
export async function enqueueUpload(body: Record<string, unknown>) {
  const caller = await requireUploadUser()
  const id = uploadId(body.uploadId)
  const retryOnly = body.retryOnly === true
  if (retryOnly) {
    const old = await pgQueryOne<{ body: Record<string, unknown> }>(
      'SELECT body FROM upload_processing_jobs WHERE upload_id=$1 AND owner=$2',
      [id, caller.username],
    )
    if (!old) throw new HttpError(404, 'Queued upload not found')
    body = old.body
  }
  const epoch = await pgAuthEpoch()
  async function prepare(): Promise<
    | { done: true; result: Record<string, unknown> }
    | { done: false; thumbnail: unknown; existing: boolean }
  > {
    // Recheck on both sides of preview storage, before queue/session locks.
    await requireUploadAccountAuthority(caller.username)
    // Consistent queue -> session lock ordering with completion publication.
    const old = await pgQueryOne<{ state: string }>(
      'SELECT state FROM upload_processing_jobs WHERE upload_id=$1 AND owner=$2 FOR UPDATE',
      [id, caller.username],
    )
    const { total, thumbnail } = await freezeUploadMetadata(caller.username, body)
    if (
      thumbnail !== undefined &&
      (typeof thumbnail !== 'string' ||
        thumbnail.length > MAX_THUMBNAIL_BYTES * 1.4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(thumbnail))
    )
      throw new HttpError(400, 'Invalid thumbnail')
    const session = await pgQueryOne<{ result: Record<string, unknown> | null; bytes: string }>(
      'SELECT result,bytes FROM upload_sessions WHERE upload_id=$1 AND owner=$2',
      [id, caller.username],
    )
    if (session?.result) {
      await requireAlbumAccess(Number(session.result.eventId), true, caller)
      return { done: true, result: session.result }
    }
    if (old && old.state !== 'failed') return { done: true, result: { queued: true, uploadId: id } }
    const chunks = await pgQueryOne<{ n: number; bytes: string; valid: boolean }>(
      `SELECT count(*)::int n,coalesce(sum(byte_size),0)::text bytes,
       bool_and(chunk_index>=0 AND chunk_index<$2 AND byte_size>0 AND byte_size<=$3
         AND (chunk_index=$2-1 OR byte_size=$3)) valid FROM upload_chunks WHERE upload_id=$1`,
      [id, total, CHUNK_BYTES],
    )
    if (
      chunks?.n !== total ||
      !chunks.valid ||
      Number(chunks.bytes) !== Number(session?.bytes) ||
      Number(chunks.bytes) > MAX_FILE_BYTES
    )
      throw new HttpError(409, 'Upload has missing or invalid chunks')
    // A per-owner backlog budget bounds durable storage without a global bottleneck.
    await pgQuery('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `upload-enqueue:${caller.username}`,
    ])
    const pending = await pgQueryOne<{ n: number }>(
      "SELECT count(*)::int n FROM upload_processing_jobs WHERE owner=$1 AND state IN ('queued','processing')",
      [caller.username],
    )
    if ((pending?.n ?? 0) >= uploadLimit('UPLOAD_QUEUED_PER_USER', 1000))
      throw new HttpError(429, 'Processing queue is full; waiting for saved files', 10)
    // Refuse a file the worker would reject anyway before it is downloaded and
    // reassembled: the name, the format and the image size are already known here.
    const kind = uploadFileKind(body.fileName)
    if (!kind.video && Number(session?.bytes) > MAX_IMAGE_BYTES)
      throw new HttpError(413, 'Image exceeds 64 MiB')
    return { done: false, thumbnail, existing: !!old }
  }
  const prepared = await pgTransaction(prepare)
  if (prepared.done) return prepared.result
  let preview: { path: string; size: number; hash: string } | null = null
  if (typeof prepared.thumbnail === 'string' && !prepared.existing) {
    const data = Buffer.from(prepared.thumbnail, 'base64')
    if (!data.length || data.length > MAX_THUMBNAIL_BYTES)
      throw new HttpError(400, 'Invalid thumbnail size')
    preview = {
      path: await storeUploadChunk(id, 0, data),
      size: data.length,
      hash: createHash('sha256').update(data).digest('hex'),
    }
  }
  return pgTransaction(async () => {
    // Recheck cancellation, chunks, permissions, and queue capacity after storage.
    const checked = await prepare()
    if (checked.done) return checked.result
    // The job keeps the same bounded details as the session, never the raw request.
    const queuedBody = { ...completionFields(body), queuedProcessing: true }
    await pgQuery(
      `INSERT INTO upload_processing_jobs(upload_id,owner,body,caller,auth_epoch,thumbnail)
      VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6::jsonb) ON CONFLICT(upload_id) DO UPDATE SET
      state='queued',attempts=0,next_attempt=now(),lease_token=NULL,lease_until=NULL,
      caller=EXCLUDED.caller,auth_epoch=EXCLUDED.auth_epoch,created_at=now(),error=NULL,updated_at=now()
      WHERE upload_processing_jobs.state='failed'`,
      [
        id,
        caller.username,
        JSON.stringify(queuedBody),
        JSON.stringify(caller),
        epoch,
        JSON.stringify(preview),
      ],
    )
    await pgQuery(
      "UPDATE upload_sessions SET expires_at=GREATEST(expires_at,NOW()+INTERVAL '7 days') WHERE upload_id=$1",
      [id],
    )
    return { queued: true, uploadId: id }
  })
}
export async function uploadProcessingStatus(ids: string[], owner: string) {
  const rows = await pgQuery<{
    uploadId: string
    result: Record<string, unknown> | null
    state: string
    error: string | null
  }>(
    `SELECT s.upload_id AS "uploadId",s.result,j.state,j.error
    FROM upload_sessions s JOIN upload_processing_jobs j USING(upload_id)
    WHERE s.owner=$1 AND s.upload_id=ANY($2::uuid[])`,
    [owner, ids],
  )
  const caller = await requireUploadUser()
  // One permission check per album in this response, never across requests.
  const albumAccess = new Map<number, boolean>()
  for (const row of rows)
    if (row.result) {
      const eventId = Number(row.result.eventId)
      if (!albumAccess.has(eventId)) {
        try {
          await requireAlbumAccess(eventId, true, caller)
          albumAccess.set(eventId, true)
        } catch (error) {
          if (!(error instanceof HttpError) || ![403, 404].includes(error.status)) throw error
          albumAccess.set(eventId, false)
        }
      }
      if (!albumAccess.get(eventId)) {
        row.result = null
        row.state = 'failed'
        row.error = 'Album access is no longer available'
      }
    }
  return rows
}
