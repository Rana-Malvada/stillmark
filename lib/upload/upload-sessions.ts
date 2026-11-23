import { uploadLimit } from './upload-capacity'
import {
  claimUploadCompletion,
  publishUploadCompletion,
  releaseUploadCompletion,
  renewUploadCompletion,
} from './upload-completion-claim'
import { prepareUploadChunkUrls, readUploadChunk } from './upload-chunk-stage'
import { writeUploadChunk } from './upload-chunk-write'
import { mkdtemp, open, rm, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DiskVideo } from '@/lib/upload/upload-source'
import { VIDEO_EXTS } from '@/lib/upload/upload-processing'
import { type AlbumCaller, requireAlbumAccess, requireUploadUser } from '@/lib/albums/album-access'
import { createHash } from 'node:crypto'
import { pgQuery, pgQueryOne, pgTransaction } from '@/lib/postgres'
import { HttpError, integer, textValue } from '@/lib/http'
import {
  CHUNK_BYTES,
  MAX_CHUNKS,
  MAX_FILE_BYTES,
  MAX_THUMBNAIL_BYTES,
} from '@/lib/upload/upload-limits'
import { completionFields } from '@/lib/upload/upload-completion-fields'
import { ingestUpload } from '@/lib/upload/ingest-upload'
import { flagOn } from '../flags'

export function uploadId(value: unknown): string {
  const id = textValue(value, 'uploadId', 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    throw new HttpError(400, 'Invalid uploadId')
  return id
}
interface Session {
  owner: string
  total_chunks: number
  bytes: string
  result: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
}

export async function saveChunk(owner: string, form: FormData) {
  const id = uploadId(form.get('uploadId'))
  const total = integer(form.get('totalChunks'), 'totalChunks', 1, MAX_CHUNKS)
  const index = integer(form.get('chunkIndex'), 'chunkIndex', 0, total - 1)
  const chunk = form.get('chunk')
  if (!(chunk instanceof File) || chunk.size < 1 || chunk.size > CHUNK_BYTES)
    throw new HttpError(413, 'Invalid chunk size')
  if (index < total - 1 && chunk.size !== CHUNK_BYTES) throw new HttpError(400, 'Incomplete chunk')
  const buffer = Buffer.from(await chunk.arrayBuffer())
  const hash = createHash('sha256').update(buffer).digest('hex')
  const globalLimit = uploadLimit(
    'UPLOAD_SESSIONS_GLOBAL',
    flagOn('UPLOAD_PROCESSING_QUEUE_ENABLED') ? 0 : 8,
    true,
  )
  await pgTransaction(async () => {
    await pgQuery('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      globalLimit > 0 ? 'upload-session-create' : `upload-session-create:${owner}`,
    ])
    let session = await pgQueryOne<Session>(
      'SELECT * FROM upload_sessions WHERE upload_id=$1 FOR UPDATE',
      [id],
    )
    if (!session) {
      const counts = await pgQueryOne<{ all_count: number; owner_count: number }>(
        globalLimit > 0
          ? 'SELECT photo_security.active_upload_count()::int AS all_count, COUNT(*) FILTER (WHERE owner=$1)::int AS owner_count FROM upload_sessions WHERE expires_at>NOW() AND result IS NULL AND NOT EXISTS (SELECT 1 FROM upload_processing_jobs j WHERE j.upload_id=upload_sessions.upload_id)'
          : 'SELECT 0 AS all_count, COUNT(*)::int AS owner_count FROM upload_sessions WHERE owner=$1 AND expires_at>NOW() AND result IS NULL AND NOT EXISTS (SELECT 1 FROM upload_processing_jobs j WHERE j.upload_id=upload_sessions.upload_id)',
        [owner],
      )
      if (
        (globalLimit > 0 && counts!.all_count >= globalLimit) ||
        counts!.owner_count >= uploadLimit('UPLOAD_SESSIONS_PER_USER', 4)
      )
        throw new HttpError(429, 'Too many active uploads; finish or cancel one first')
      // Queued uploads are bounded by receiving concurrency and queue backlog.
      // A fixed per-minute window otherwise stalls healthy, fast album transfers.
      const startsPerMinute = uploadLimit(
        'UPLOAD_STARTS_PER_USER_PER_MINUTE',
        flagOn('UPLOAD_PROCESSING_QUEUE_ENABLED') ? 0 : 60,
        true,
      )
      if (startsPerMinute > 0) {
        // The owner admission lock serializes an explicitly enabled budget.
        const budget = await pgQueryOne<{ starts: number; retry_after: number }>(
          `INSERT INTO upload_start_limits(owner,window_start,starts) VALUES($1,now(),1)
          ON CONFLICT(owner) DO UPDATE SET
          starts=CASE WHEN upload_start_limits.window_start<=now()-interval '1 minute' THEN 1 ELSE upload_start_limits.starts+1 END,
          window_start=CASE WHEN upload_start_limits.window_start<=now()-interval '1 minute' THEN now() ELSE upload_start_limits.window_start END
          RETURNING starts, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (window_start + interval '1 minute' - now()))))::int AS retry_after`,
          [owner],
        )
        if (budget!.starts > startsPerMinute)
          throw new HttpError(
            429,
            'Upload batch is moving quickly; waiting for the next upload window',
            budget!.retry_after,
          )
      }
      try {
        await pgQuery(
          'INSERT INTO upload_sessions(upload_id,owner,total_chunks) VALUES ($1,$2,$3)',
          [id, owner, total],
        )
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'P0001' &&
          error.message === 'Account upload allowance reached; contact an administrator'
        ) {
          throw new HttpError(
            422,
            'Your upload allowance has been reached. Contact an administrator to increase it.',
          )
        }
        // Row-level security hides another member's session from the lookup above, so
        // an upload ID that already exists but was not visible belongs to someone else.
        if (error instanceof Error && 'code' in error && error.code === '23505')
          throw new HttpError(403, 'Upload belongs to another user')
        throw error
      }
      session = { owner, total_chunks: total, bytes: '0', result: null, metadata: null }
    }
    if (session.owner !== owner) throw new HttpError(403, 'Upload belongs to another user')
    if (session.total_chunks !== total) throw new HttpError(409, 'Upload metadata changed')
    if (session.result) return { ok: true, completed: true }
  })
  return writeUploadChunk(id, owner, total, index, hash, buffer)
}

export async function freezeUploadMetadata(owner: string, body: Record<string, unknown>) {
  const id = uploadId(body.uploadId)
  const total = integer(body.totalChunks, 'totalChunks', 1, MAX_CHUNKS)
  const thumbnail = body.thumbnail
  const metadata = completionFields(body)
  // Metadata is frozen on first completion attempt, including a failed attempt.
  await pgTransaction(async () => {
    const session = await pgQueryOne<Session>(
      'SELECT * FROM upload_sessions WHERE upload_id=$1 AND expires_at>NOW() FOR UPDATE',
      [id],
    )
    if (!session) throw new HttpError(404, 'Upload expired or not found')
    if (session.owner !== owner) throw new HttpError(403, 'Upload belongs to another user')
    if (session.total_chunks !== total) throw new HttpError(409, 'Chunk count changed')
    const normalized = JSON.stringify(
      Object.fromEntries(Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b))),
    )
    // Sessions frozen before unknown keys were dropped compare on the same known keys.
    const previous =
      session.metadata &&
      JSON.stringify(
        Object.fromEntries(
          Object.entries(completionFields(session.metadata)).sort(([a], [b]) => a.localeCompare(b)),
        ),
      )
    if (previous && previous !== normalized) throw new HttpError(409, 'Upload metadata changed')
    await pgQuery('UPDATE upload_sessions SET metadata=$2::jsonb WHERE upload_id=$1', [
      id,
      normalized,
    ])
  })
  return { id, total, thumbnail, metadata }
}

export async function completeUpload(
  owner: string,
  body: Record<string, unknown>,
  authenticatedCaller?: AlbumCaller,
  queuedToken?: string,
  confirmAuthority?: () => Promise<void>,
) {
  const caller = authenticatedCaller ?? (await requireUploadUser())
  if (caller.username !== owner) throw new HttpError(403, 'Upload belongs to another user')
  const { id, total, thumbnail, metadata } = await freezeUploadMetadata(owner, body)
  const claim = await claimUploadCompletion(id, owner, queuedToken)
  if (claim.result) {
    await requireAlbumAccess(Number(claim.result.eventId), true, caller)
    return claim.result
  }
  const token = claim.token!
  let lost = false
  let renewing = false
  const heartbeat = setInterval(async () => {
    if (renewing) return
    renewing = true
    try {
      if (!(await renewUploadCompletion(id, token))) lost = true
    } catch {
      lost = true
    } finally {
      renewing = false
    }
  }, 30000)
  heartbeat.unref()
  try {
    const session = await pgQueryOne<Session>(
      'SELECT * FROM upload_sessions WHERE upload_id=$1 AND owner=$2',
      [id, owner],
    )
    if (!session) throw new HttpError(404, 'Upload not found')
    if (session.result) {
      await requireAlbumAccess(Number(session.result.eventId), true, caller)
      return session.result
    }
    const bytes = Number(session.bytes)
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_FILE_BYTES)
      throw new HttpError(413, 'Invalid upload size')
    const video = VIDEO_EXTS.has(
      String(metadata.fileName ?? '')
        .split('.')
        .pop()
        ?.toLowerCase() ?? '',
    )
    if (!video && bytes > 64 * 1024 * 1024) throw new HttpError(413, 'Image exceeds 64 MiB')
    if (video) {
      const space = await statfs(tmpdir())
      if (space.bavail * space.bsize < bytes + 1024 ** 3)
        throw new HttpError(429, 'Video processing space is busy; retry shortly', 5)
    }
    const dir = video ? await mkdtemp(join(tmpdir(), 'gallery-video-')) : null
    const path = dir ? join(dir, 'video') : null
    const disk = path ? await open(path, 'w+') : null
    try {
      const memory = video ? null : Buffer.allocUnsafe(bytes)
      const hash = createHash('sha256')
      let offset = 0
      for (let index = 0; index < total; index++) {
        if (lost) throw new HttpError(409, 'Upload processing interrupted; retry upload')
        if (index % 16 === 0) {
          const upcoming = await pgQuery<{ stage_path: string }>(
            'SELECT stage_path FROM upload_chunks WHERE upload_id=$1 AND chunk_index >= $2 AND chunk_index < $3 AND stage_path IS NOT NULL ORDER BY chunk_index',
            [id, index, Math.min(total, index + 16)],
          )
          await prepareUploadChunkUrls(upcoming.map((chunk) => chunk.stage_path))
        }
        const stored = await pgQueryOne<{
          data: Buffer | null
          stage_path: string | null
          byte_size: number
          hash: string
        }>(
          'SELECT data,stage_path,byte_size,hash FROM upload_chunks WHERE upload_id=$1 AND chunk_index=$2',
          [id, index],
        )
        const chunk = stored
          ? {
              data: stored.stage_path
                ? await readUploadChunk(stored.stage_path, stored.byte_size, stored.hash)
                : stored.data!,
            }
          : null
        if (
          !chunk ||
          (index < total - 1 && chunk.data.length !== CHUNK_BYTES) ||
          offset + chunk.data.length > bytes
        )
          throw new HttpError(409, 'Upload has missing or invalid chunks')
        hash.update(chunk.data)
        if (disk) {
          let written = 0
          while (written < chunk.data.length) {
            const part = await disk.write(
              chunk.data,
              written,
              chunk.data.length - written,
              offset + written,
            )
            if (!part.bytesWritten) throw new Error('Unable to write video')
            written += part.bytesWritten
          }
        } else memory!.set(chunk.data, offset)
        offset += chunk.data.length
      }
      if (offset !== bytes) throw new HttpError(409, 'Upload size mismatch')
      const buffer: Buffer | DiskVideo = memory ?? {
        path: path!,
        length: bytes,
        hash: hash.digest('hex'),
        read: async (offset, length) => {
          const result = Buffer.alloc(Math.min(length, Math.max(0, bytes - offset)))
          let read = 0
          while (read < result.length) {
            const part = await disk!.read(result, read, result.length - read, offset + read)
            if (!part.bytesRead) break
            read += part.bytesRead
          }
          return result.subarray(0, read)
        },
      }
      let thumb: Buffer | undefined
      if (thumbnail !== undefined) {
        if (
          typeof thumbnail !== 'string' ||
          thumbnail.length > MAX_THUMBNAIL_BYTES * 1.4 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(thumbnail)
        )
          throw new HttpError(400, 'Invalid thumbnail')
        thumb = Buffer.from(thumbnail, 'base64')
        if (thumb.length > MAX_THUMBNAIL_BYTES) throw new HttpError(413, 'Thumbnail too large')
      }
      if (lost) throw new HttpError(409, 'Upload processing interrupted; retry upload')
      return await ingestUpload(buffer, metadata, thumb, caller, (fn) => {
        if (lost) throw new HttpError(409, 'Upload processing interrupted; retry upload')
        return publishUploadCompletion(id, owner, token, fn, queuedToken, confirmAuthority)
      })
    } finally {
      try {
        await disk?.close()
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true })
      }
    }
  } finally {
    clearInterval(heartbeat)
    await releaseUploadCompletion(id, token).catch(() =>
      console.error('[upload-claim-release] failed; lease will expire'),
    )
  }
}
