import { uploadStep } from './upload-profile'
import { videoPoster } from '../video/video-compression'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateVideo } from '../video/video-validation'
import type { DiskVideo } from '@/lib/upload/upload-source'
import { HttpError } from '@/lib/http'
import { pgQuery, pgQueryOne } from '@/lib/postgres'
import { checkDuplicateHash, insertPhoto, updatePhotoRenditions } from '@/lib/photos'
import { putFilesToStage } from '@/lib/snowflake/stage-upload'
import { createHash, randomUUID } from 'crypto'

import { photoCaptureDate } from '../capture-date'
import { videoMetadata } from '../video/video-metadata'
import exifr from 'exifr'
import sharp from 'sharp'
import { decodeHeif } from './heif-decode'

export const IMAGE_EXTS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'tiff',
  'tif',
  'heic',
  'heif',
])
export const VIDEO_EXTS = new Set(['mov', 'mp4', 'm4v'])
export const SUPPORTED_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS])

function safeJsonStringify(obj: unknown): string | null {
  if (!obj) return null
  try {
    return JSON.stringify(obj, (_key, value) => {
      if (value instanceof Uint8Array || Buffer.isBuffer(value)) return undefined
      if (typeof value === 'string') return value.replace(/\u0000/g, '')
      return value
    })
  } catch {
    return null
  }
}

export type ProcessResult = {
  filename: string
  status: string
  photoId?: number
  existingFilename?: string
  error?: string
}

async function duplicateResult(
  eventId: number,
  hash: string,
  filename: string,
  jobId: number,
): Promise<ProcessResult | null> {
  const id = await checkDuplicateHash(eventId, hash)
  if (!id) return null
  await pgQuery(
    "INSERT INTO upload_files(upload_job_id,source_filename,file_hash,status,error_message) VALUES($1,$2,$3,'SKIPPED',$4)",
    [jobId, filename, hash, `Duplicate of photo ${id}`],
  )
  const existing = await pgQueryOne<{ source_filename: string }>(
    'SELECT source_filename FROM photos WHERE photo_id=$1',
    [id],
  )
  return { filename, status: 'skipped', photoId: id, existingFilename: existing?.source_filename }
}
async function duplicatePublisher(eventId: number, hash: string, filename: string) {
  if (!(await checkDuplicateHash(eventId, hash))) return null
  return async (jobId: number) => {
    const result = await duplicateResult(eventId, hash, filename, jobId)
    if (!result) throw new HttpError(409, 'Existing duplicate changed; retry upload')
    return result
  }
}

export async function prepareImage(
  buffer: Buffer,
  filename: string,
  ext: string,
  folderName: string,
  eventId: number,
): Promise<(jobId: number) => Promise<ProcessResult>> {
  const hash = createHash('sha256').update(buffer).digest('hex')
  const duplicate = await uploadStep('duplicateCheck', () =>
    duplicatePublisher(eventId, hash, filename),
  )
  if (duplicate) return duplicate

  const [exifData, metadata] = await uploadStep('metadata', () =>
    Promise.all([
      exifr
        .parse(buffer, {
          gps: true,
          xmp: true,
          iptc: true,
          icc: true,
          interop: true,
          makerNote: true,
          userComment: true,
        })
        .catch(() => null),
      sharp(buffer, { limitInputPixels: 80_000_000 })
        .metadata()
        .catch(() => null),
    ]),
  )

  const heif =
    ['heic', 'heif'].includes(ext.toLowerCase()) || metadata?.format === 'heif'
      ? await uploadStep('heifDecode', () => decodeHeif(buffer))
      : null
  const renditionSource = heif?.buffer ?? buffer
  const width = metadata?.width ?? heif?.width ?? null
  const height = metadata?.height ?? heif?.height ?? null
  const orientation = metadata?.orientation ?? null
  const aspectRatio = width && height ? width / height : null
  const contentType = `image/${ext === 'jpg' ? 'jpeg' : ext}`
  const dateTaken = photoCaptureDate(exifData?.DateTimeOriginal, exifData?.OffsetTimeOriginal)

  const safeFolder = `${eventId}/${randomUUID()}`
  const originalPath = `originals/${safeFolder}/original.${ext}`
  const jpgName = 'image.jpg'
  const displayPath = `display/2400/${safeFolder}/${jpgName}`
  const thumbnailPath = `thumbnails/400/${safeFolder}/${jpgName}`

  const [displayBuffer, thumbBuffer] = await uploadStep('renditions', () =>
    Promise.all([
      sharp(renditionSource, { limitInputPixels: 80_000_000 })
        .rotate()
        .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer()
        .catch(() => null),
      sharp(renditionSource, { limitInputPixels: 80_000_000 })
        .rotate()
        .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer()
        .catch(() => null),
    ]),
  )

  if (!displayBuffer || !thumbBuffer)
    throw new HttpError(422, 'Unable to decode this image; convert it to JPEG and retry')
  const uploads: Array<{ buffer: Buffer; stagePath: string }> = [
    { buffer, stagePath: originalPath },
  ]
  if (displayBuffer) uploads.push({ buffer: displayBuffer, stagePath: displayPath })
  if (thumbBuffer) uploads.push({ buffer: thumbBuffer, stagePath: thumbnailPath })
  await uploadStep('stageWrites', () => putFilesToStage(uploads))

  return async (jobId: number) => {
    const dupId = await checkDuplicateHash(eventId, hash)
    if (dupId) {
      await pgQuery(
        `INSERT INTO upload_files (upload_job_id, source_filename, file_hash, status, error_message) VALUES ($1, $2, $3, 'SKIPPED', $4)`,
        [jobId, filename, hash, `Duplicate of photo ${dupId}`],
      )
      const existing = await pgQueryOne<{ source_filename: string }>(
        'SELECT source_filename FROM photos WHERE photo_id=$1',
        [dupId],
      )
      return {
        filename,
        status: 'skipped',
        photoId: dupId,
        existingFilename: existing?.source_filename,
      }
    }
    const photoId = await insertPhoto({
      eventId,
      sourceFilename: filename,
      sourceRelativePath: `${folderName}/${filename}`,
      originalStagePath: originalPath,
      fileSizeBytes: buffer.length,
      contentType,
      fileExtension: ext,
      fileHash: hash,
      width,
      height,
      aspectRatio,
      orientation,
      dateTaken,
      cameraMake: exifData?.Make ? String(exifData.Make) : null,
      cameraModel: exifData?.Model ? String(exifData.Model) : null,
      lensModel: exifData?.LensModel ? String(exifData.LensModel) : null,
      lensMake: exifData?.LensMake ? String(exifData.LensMake) : null,
      lensSerial: exifData?.LensSerialNumber ? String(exifData.LensSerialNumber) : null,
      software: exifData?.Software ? String(exifData.Software) : null,
      artist: exifData?.Artist ? String(exifData.Artist) : null,
      copyright: exifData?.Copyright ? String(exifData.Copyright) : null,
      focalLength: exifData?.FocalLength ? String(exifData.FocalLength) : null,
      aperture: exifData?.FNumber ? String(exifData.FNumber) : null,
      shutterSpeed: exifData?.ExposureTime ? String(exifData.ExposureTime) : null,
      iso: exifData?.ISO ? Number(exifData.ISO) : null,
      exposureCompensation:
        exifData?.ExposureCompensation != null ? String(exifData.ExposureCompensation) : null,
      flashUsed: exifData?.Flash != null ? Boolean(exifData.Flash & 1) : null,
      exposureProgram: exifData?.ExposureProgram ? String(exifData.ExposureProgram) : null,
      meteringMode: exifData?.MeteringMode ? String(exifData.MeteringMode) : null,
      lightSource: exifData?.LightSource ? String(exifData.LightSource) : null,
      whiteBalance: exifData?.WhiteBalance != null ? String(exifData.WhiteBalance) : null,
      exposureMode: exifData?.ExposureMode != null ? String(exifData.ExposureMode) : null,
      sceneCaptureType:
        exifData?.SceneCaptureType != null ? String(exifData.SceneCaptureType) : null,
      contrast: exifData?.Contrast != null ? String(exifData.Contrast) : null,
      saturationVal: exifData?.Saturation != null ? String(exifData.Saturation) : null,
      sharpnessVal: exifData?.Sharpness != null ? String(exifData.Sharpness) : null,
      brightness: exifData?.BrightnessValue != null ? String(exifData.BrightnessValue) : null,
      focalLength35mm: exifData?.FocalLengthIn35mmFormat
        ? String(exifData.FocalLengthIn35mmFormat)
        : null,
      digitalZoomRatio:
        exifData?.DigitalZoomRatio != null ? String(exifData.DigitalZoomRatio) : null,
      colorSpace: exifData?.ColorSpace ? String(exifData.ColorSpace) : null,
      subjectDistanceRange: exifData?.SubjectDistanceRange
        ? String(exifData.SubjectDistanceRange)
        : null,
      latitude: exifData?.latitude != null ? Number(exifData.latitude) : null,
      longitude: exifData?.longitude != null ? Number(exifData.longitude) : null,
      altitude: exifData?.GPSAltitude ? Number(exifData.GPSAltitude) : null,
      gpsDirection: exifData?.GPSImgDirection != null ? Number(exifData.GPSImgDirection) : null,
      gpsSpeed: exifData?.GPSSpeed != null ? Number(exifData.GPSSpeed) : null,
      gpsTimestamp: (() => {
        try {
          if (!exifData?.GPSDateStamp || !exifData?.GPSTimeStamp) return null
          const ds =
            exifData.GPSDateStamp instanceof Date
              ? exifData.GPSDateStamp.toISOString().slice(0, 10)
              : String(exifData.GPSDateStamp).replace(/:/g, '-')
          const ts = Array.isArray(exifData.GPSTimeStamp)
            ? exifData.GPSTimeStamp.map((n: number) => String(Math.floor(n)).padStart(2, '0')).join(
                ':',
              )
            : String(exifData.GPSTimeStamp)
          const d = new Date(`${ds}T${ts}Z`)
          return isNaN(d.getTime()) ? null : d.toISOString()
        } catch {
          return null
        }
      })(),
      gpsHPositioningError:
        exifData?.GPSHPositioningError != null ? Number(exifData.GPSHPositioningError) : null,
      iptcKeywords: exifData?.keywords
        ? Array.isArray(exifData.keywords)
          ? exifData.keywords.map(String)
          : [String(exifData.keywords)]
        : null,
      iptcHeadline: exifData?.headline ? String(exifData.headline) : null,
      iptcCopyright: exifData?.copyrightNotice ? String(exifData.copyrightNotice) : null,
      dateTakenRaw: exifData?.DateTimeOriginal ? String(exifData.DateTimeOriginal) : null,
      exifRaw: safeJsonStringify(exifData),
      // exifr returns one combined parsed document. Store it once in exif_raw;
      // these legacy columns are reserved for distinct metadata, not duplicates.
      xmpRaw: null,
      iptcRaw: null,
      iccRaw: null,
      ingestStatus: displayBuffer && thumbBuffer ? 'READY' : 'RENDITIONS_PENDING',
      mediaType: 'photo',
    })

    if (displayBuffer && thumbBuffer) {
      await updatePhotoRenditions(photoId, displayPath, thumbnailPath)
    }

    await pgQuery(
      `INSERT INTO upload_files (upload_job_id, photo_id, source_filename, file_hash, stage_path, status, file_size_bytes) VALUES ($1, $2, $3, $4, $5, 'SUCCESS', $6)`,
      [jobId, photoId, filename, hash, originalPath, buffer.length],
    )
    return { filename, status: 'success', photoId }
  }
}

export async function prepareVideo(
  buffer: Buffer | DiskVideo,
  filename: string,
  ext: string,
  folderName: string,
  eventId: number,
  clientThumbnail?: Buffer,
): Promise<(jobId: number) => Promise<ProcessResult>> {
  await validateVideo(
    async (offset, length) =>
      Buffer.isBuffer(buffer)
        ? buffer.subarray(offset, offset + length)
        : buffer.read(offset, length),
    buffer.length,
  )
  const hash = Buffer.isBuffer(buffer)
    ? createHash('sha256').update(buffer).digest('hex')
    : buffer.hash
  const duplicate = await duplicatePublisher(eventId, hash, filename)
  if (duplicate) return duplicate

  const metadata = await videoMetadata(
    async (offset, length) =>
      Buffer.isBuffer(buffer)
        ? buffer.subarray(offset, offset + length)
        : buffer.read(offset, length),
    buffer.length,
  )
  const capture = metadata.capture
  const contentType = ext.toLowerCase() !== 'mov' ? 'video/mp4' : 'video/quicktime'
  const safeFolder = `${eventId}/${randomUUID()}`
  const originalPath = `originals/${safeFolder}/original.${ext}`
  const thumbName = 'image.jpg'
  const thumbnailPath = `thumbnails/400/${safeFolder}/${thumbName}`

  // Normalize browser thumbnails; never serve arbitrary client bytes as JPEG.
  const normalizePoster = (data: Buffer) =>
    sharp(data, { limitInputPixels: 8_000_000 })
      .rotate()
      .resize({ width: 400, height: 400, fit: 'inside' })
      .jpeg({ quality: 80 })
      .toBuffer()
  if (clientThumbnail?.length) {
    try {
      clientThumbnail = await normalizePoster(clientThumbnail)
    } catch {
      // An undecodable client poster is the client's mistake, not a failed upload:
      // fall back to a server-made poster instead of retrying the whole video.
      console.warn('[upload] Client video poster rejected; generating one instead')
      clientThumbnail = undefined
    }
  }
  // A native mobile picker or unsupported browser codec may supply no poster.
  if (!clientThumbnail?.length) {
    let dir: string | undefined
    let generated: Buffer | undefined
    try {
      let input: string
      if (Buffer.isBuffer(buffer)) {
        dir = await mkdtemp(join(tmpdir(), 'upload-poster-'))
        input = join(dir, 'video')
        await writeFile(input, buffer)
      } else input = buffer.path
      generated = await videoPoster(input)
    } catch {
      console.warn('[upload] Video poster unavailable; original upload preserved')
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true })
    }
    // A failure to normalize the server's own poster is a server fault: let the
    // job retry instead of publishing the video without a poster.
    if (generated?.length) clientThumbnail = await normalizePoster(generated)
  }
  const uploads: Array<{ buffer: Buffer | string; stagePath: string }> = [
    { buffer: Buffer.isBuffer(buffer) ? buffer : buffer.path, stagePath: originalPath },
  ]
  if (clientThumbnail && clientThumbnail.length > 0) {
    console.log(
      `[upload] Storing client thumbnail for ${filename} (${clientThumbnail.length} bytes)`,
    )
    uploads.push({ buffer: clientThumbnail, stagePath: thumbnailPath })
  }
  await putFilesToStage(uploads)

  return async (jobId: number) => {
    const dupId = await checkDuplicateHash(eventId, hash)
    if (dupId) {
      await pgQuery(
        `INSERT INTO upload_files (upload_job_id, source_filename, file_hash, status, error_message) VALUES ($1, $2, $3, 'SKIPPED', $4)`,
        [jobId, filename, hash, `Duplicate of video ${dupId}`],
      )
      const existing = await pgQueryOne<{ source_filename: string }>(
        'SELECT source_filename FROM photos WHERE photo_id=$1',
        [dupId],
      )
      return {
        filename,
        status: 'skipped',
        photoId: dupId,
        existingFilename: existing?.source_filename,
      }
    }
    const photoId = await insertPhoto({
      eventId,
      sourceFilename: filename,
      sourceRelativePath: `${folderName}/${filename}`,
      originalStagePath: originalPath,
      fileSizeBytes: buffer.length,
      contentType,
      fileExtension: ext,
      fileHash: hash,
      width: metadata.width,
      height: metadata.height,
      aspectRatio: metadata.width && metadata.height ? metadata.width / metadata.height : null,
      orientation: null,
      dateTaken: capture?.date ?? null,
      cameraMake: metadata.cameraMake,
      cameraModel: metadata.cameraModel,
      lensModel: null,
      lensMake: null,
      lensSerial: null,
      software: metadata.software,
      artist: null,
      copyright: null,
      focalLength: null,
      aperture: null,
      shutterSpeed: null,
      iso: null,
      exposureCompensation: null,
      flashUsed: null,
      exposureProgram: null,
      meteringMode: null,
      lightSource: null,
      whiteBalance: null,
      exposureMode: null,
      sceneCaptureType: null,
      contrast: null,
      saturationVal: null,
      sharpnessVal: null,
      brightness: null,
      focalLength35mm: null,
      digitalZoomRatio: null,
      colorSpace: null,
      subjectDistanceRange: null,
      latitude: metadata.latitude,
      longitude: metadata.longitude,
      altitude: metadata.altitude,
      gpsDirection: null,
      gpsSpeed: null,
      gpsTimestamp: null,
      gpsHPositioningError: null,
      iptcKeywords: null,
      iptcHeadline: null,
      iptcCopyright: null,
      dateTakenRaw: capture?.raw ?? null,
      exifRaw: JSON.stringify({
        videoCaptureSource: capture?.source ?? null,
        videoMetadataVersion: 1,
        videoTags: metadata.tags,
      }),
      xmpRaw: null,
      iptcRaw: null,
      iccRaw: null,
      ingestStatus: 'READY',
      mediaType: 'video',
    })

    await updatePhotoRenditions(
      photoId,
      originalPath,
      clientThumbnail && clientThumbnail.length > 0 ? thumbnailPath : null,
    )

    await pgQuery(
      `INSERT INTO upload_files (upload_job_id, photo_id, source_filename, file_hash, stage_path, status, file_size_bytes) VALUES ($1, $2, $3, $4, $5, 'SUCCESS', $6)`,
      [jobId, photoId, filename, hash, originalPath, buffer.length],
    )
    return { filename, status: 'success', photoId }
  }
}

// Legacy internal callers publish immediately; upload completion uses prepared publishers.
export async function processImage(
  buffer: Buffer,
  filename: string,
  ext: string,
  folderName: string,
  eventId: number,
  jobId: number,
) {
  return (await prepareImage(buffer, filename, ext, folderName, eventId))(jobId)
}
export async function processVideo(
  buffer: Buffer | DiskVideo,
  filename: string,
  ext: string,
  folderName: string,
  eventId: number,
  jobId: number,
  thumbnail?: Buffer,
) {
  return (await prepareVideo(buffer, filename, ext, folderName, eventId, thumbnail))(jobId)
}
