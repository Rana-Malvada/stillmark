import { ZipArchive } from 'archiver'
import { PassThrough, Readable } from 'node:stream'
import { once } from 'node:events'
import { HttpError } from '@/lib/http'
import { getPresignedUrl, invalidateMediaUrl } from '@/lib/media/image-urls'

export type ZipPhoto = {
  photo_id: number
  source_filename: string
  original_stage_path: string
}

/**
 * Decides, at the moment it is called, whether one photo may still be downloaded.
 *
 * Returns the storage path of the original the caller is authorized to read now, or null
 * when the photo is no longer part of what was requested (moved, trashed, removed from a
 * selection, no longer ready). Throws when the whole download must stop (link revoked,
 * downloads disabled). It must read live state: the rows passed to `downloadZip` are only
 * a list of candidates captured when the download began.
 */
export type ZipAuthorize<T extends ZipPhoto = ZipPhoto> = (photo: T) => Promise<string | null>

/**
 * Stream one original at a time, preserving backpressure and cancelling upstream on disconnect.
 *
 * Every file is authorized twice with `authorize`: before its original is opened, and again
 * once storage has answered and before any of its bytes are appended. A long archive can
 * outlive the permission it started with, so nothing captured at the start is trusted.
 *
 * A file that `authorize` no longer allows (null, or a different path than the one opened) is
 * left out and the archive continues with the remaining files: the result is the archive a
 * new request would produce, whereas failing would leave a truncated, unreadable ZIP. An
 * error from `authorize` stops the transfer: the stream fails and no further file is opened.
 * Bytes of a file already being appended when access changes cannot be recalled.
 */
export async function downloadZip<T extends ZipPhoto>(
  req: Request,
  rows: T[],
  authorize: ZipAuthorize<T>,
  filename = 'photos.zip',
  headers: Record<string, string> = {},
) {
  if (!rows.length) throw new HttpError(404, 'This album has no files to download')
  const controller = new AbortController()
  const fetchOriginal = async (path: string) => {
    const signal = AbortSignal.any([controller.signal, req.signal, AbortSignal.timeout(300_000)])
    let response = await fetch(await getPresignedUrl(path), { signal, cache: 'no-store' })
    if (response.status === 403) {
      await response.body?.cancel()
      invalidateMediaUrl(path)
      response = await fetch(await getPresignedUrl(path), { signal, cache: 'no-store' })
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new HttpError(502, 'A selected file could not be downloaded')
    }
    return response
  }
  /** The open original of one photo, or null when it must be left out of the archive. */
  const openFile = async (row: T) => {
    const path = await authorize(row)
    if (path === null) return null
    const response = await fetchOriginal(path)
    let current: string | null
    try {
      // The fetch can take a long time; check again before any byte is appended.
      current = await authorize(row)
    } catch (error) {
      await response.body!.cancel()
      throw error
    }
    if (current !== path) {
      await response.body!.cancel()
      return null
    }
    return response
  }
  let next = 0
  /** The next photo that is still authorized, opened; null when none remain. */
  const nextFile = async () => {
    while (next < rows.length) {
      const row = rows[next++]
      const response = await openFile(row)
      if (response) return { row, response }
    }
    return null
  }
  // Fail visibly before starting the archive if the first original is unavailable.
  const first = await nextFile()
  if (!first) throw new HttpError(404, 'This album has no files to download')
  const output = new PassThrough()
  const archive = new ZipArchive({ store: true, forceZip64: true })
  archive.on('error', (error) => output.destroy(error))
  archive.on('warning', (error) => output.destroy(error))
  output.on('error', () => {})
  output.on('close', () => {
    controller.abort()
    archive.abort()
  })
  archive.pipe(output)
  void (async () => {
    try {
      for (let file: typeof first | null = first; file; file = await nextFile()) {
        const source = Readable.fromWeb(
          file.response.body as import('node:stream/web').ReadableStream,
        )
        source.on('error', (error) => archive.destroy(error))
        const done = once(archive, 'entry', { signal: controller.signal })
        const safeName = file.row.source_filename.replace(/[\\/\x00-\x1f\x7f]/g, '_')
        archive.append(source, { name: `${file.row.photo_id}-${safeName}` })
        await done
      }
      await archive.finalize()
    } catch (error) {
      output.destroy(error instanceof Error ? error : new Error('Download failed'))
      archive.abort()
    }
  })()
  return new Response(Readable.toWeb(output) as ReadableStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      ...headers,
    },
  })
}
