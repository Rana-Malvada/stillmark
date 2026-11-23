import type { DiskVideo } from '@/lib/upload/upload-source'
import { requireFolderWrite } from '@/lib/albums/folders'
import { createHash } from 'node:crypto'
import { type AlbumCaller, requireAlbumAccess, requireUploadUser } from '@/lib/albums/album-access'
import { pgQuery, pgQueryOne, pgTransaction } from '@/lib/postgres'
import {
  createEvent,
  findEventBySourceFolder,
  getUploadEvent,
  setCoverPhoto,
  updateEventPhotoCount,
} from '@/lib/albums/events'
import { parseEventFolder } from '@/lib/albums/folder-parser'
import { prepareImage, prepareVideo, VIDEO_EXTS } from '@/lib/upload/upload-processing'
import { HttpError, integer, textValue } from '@/lib/http'
import { MAX_FILE_BYTES, MAX_IMAGE_BYTES } from '@/lib/upload/upload-limits'
import { requireUploadAccountAuthority } from './upload-account-authority'
import { uploadFileKind } from './upload-file-kind'
import { lockManagement, lockManagementShared } from '../database/management-lock'

/** Prepare media outside transactions; publish catalog, logs and replay response atomically. */
export async function ingestUpload(
  buffer: Buffer | DiskVideo,
  fields: Record<string, unknown>,
  thumbnail?: Buffer,
  authenticatedCaller?: AlbumCaller,
  publish: <T>(fn: () => Promise<T>) => Promise<T> = pgTransaction,
) {
  const caller = authenticatedCaller ?? (await requireUploadUser())
  const { filename, ext } = uploadFileKind(fields.fileName)
  if (!buffer.length || buffer.length > (VIDEO_EXTS.has(ext) ? MAX_FILE_BYTES : MAX_IMAGE_BYTES))
    throw new HttpError(413, 'File exceeds the upload limit (64 MiB images, 4 GiB videos)')
  if (!Buffer.isBuffer(buffer) && !VIDEO_EXTS.has(ext)) throw new HttpError(415, 'Expected a video')
  const folderName = textValue(fields.folderName, 'folderName', 512)
  const parsed = caller.role === 'admin' ? parseEventFolder(folderName) : null
  const folderId = fields.folderId == null ? null : integer(fields.folderId, 'folderId')
  if (!fields.eventId && folderId === null)
    throw new HttpError(400, 'Choose a folder before uploading.')
  if (folderId !== null) await requireFolderWrite(folderId, caller)
  let eventId: number
  await pgTransaction(async () => {
    // Album creation is publication too: fence deletion before catalog locks.
    await requireUploadAccountAuthority(caller.username)
    // Existing albums may ingest concurrently; management mutations still take the
    // exclusive barrier. Album creation retains exclusive serialization and never
    // upgrades a shared lock (which could deadlock concurrent creators).
    await (fields.eventId ? lockManagementShared() : lockManagement())
    if (fields.eventId) {
      eventId = integer(fields.eventId, 'eventId')
    } else {
      const sourceKey = `user/${createHash('sha256').update(caller.username).digest('hex')}/${createHash('sha256').update(folderName).digest('hex')}`
      const existing =
        (await findEventBySourceFolder(sourceKey)) ??
        (caller.mainAdmin ? await findEventBySourceFolder(folderName) : null)
      eventId =
        existing?.eventId ??
        (await createEvent({
          ownerUsername: caller.username,
          sourceFolder: sourceKey,
          eventName: textValue(
            fields.eventName ?? parsed?.eventName ?? (caller.role === 'admin' ? folderName : ''),
            'eventName',
          ),
          sortOrder: integer(fields.sortOrder ?? parsed?.sortOrder ?? 0, 'sortOrder', 0),
          eventMonth:
            fields.eventMonth == null
              ? (parsed?.eventMonth ?? null)
              : integer(fields.eventMonth, 'eventMonth', 1, 12),
          eventYear:
            fields.eventYear == null
              ? (parsed?.eventYear ?? null)
              : integer(fields.eventYear, 'eventYear', 1, 9999),
          location: fields.location ? textValue(fields.location, 'location') : null,
          folderId,
        }))
    }
    await pgQuery('SELECT pg_advisory_xact_lock($1)', [eventId])
    await requireAlbumAccess(eventId, true, caller)
    const event = await getUploadEvent(eventId)
    if (!event) throw new HttpError(404, 'Event not found')
    if (event.folderId === null)
      throw new HttpError(400, 'Assign this album to a folder in Edit details before uploading.')
  })
  const prepared = VIDEO_EXTS.has(ext)
    ? await prepareVideo(buffer, filename, ext, folderName, eventId!, thumbnail)
    : await prepareImage(buffer as Buffer, filename, ext, folderName, eventId!)
  return publish(async () => {
    // Lock order: shared management barrier, then exclusive album lock.
    // This preserves publication/authorization fencing against management changes.
    await lockManagementShared()
    await pgQuery('SELECT pg_advisory_xact_lock($1)', [eventId!])
    await requireAlbumAccess(eventId!, true, caller)
    const event = await getUploadEvent(eventId!)
    if (!event) throw new HttpError(404, 'Event not found')
    if (event.folderId === null)
      throw new HttpError(400, 'Assign this album to a folder in Edit details before uploading.')
    const job = await pgQueryOne<{ upload_job_id: number }>(
      "INSERT INTO upload_jobs(event_id,source_folder,file_count,status) VALUES ($1,$2,1,'IN_PROGRESS') RETURNING upload_job_id",
      [eventId, folderName],
    )
    const jobId = job!.upload_job_id
    const result = await prepared(jobId)
    if (result.photoId && result.status === 'success') {
      await setCoverPhoto(eventId, result.photoId)
      // The prepared publisher returns success only for a newly inserted photo.
      // Duplicate uploads leave both the count and album search revision unchanged.
      await updateEventPhotoCount(eventId, result.photoId)
    }
    const successCount = result.status === 'success' ? 1 : 0
    const skippedCount = result.status === 'skipped' ? 1 : 0
    await pgQuery(
      "UPDATE upload_jobs SET completed_at=NOW(),success_count=$2,skipped_count=$3,total_bytes=$4,status='COMPLETED' WHERE upload_job_id=$1",
      [jobId, successCount, skippedCount, buffer.length],
    )
    return {
      eventId,
      jobId,
      totalFiles: 1,
      successCount,
      skippedCount,
      failedCount: 0,
      results: [result],
    }
  })
}
