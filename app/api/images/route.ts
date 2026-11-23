import {
  isThumbnailRequest,
  THUMBNAIL_CACHE_CONTROL,
  thumbnailValidator,
} from '@/lib/thumbnail-cache.mjs'
import { withBrowseRequest } from '@/lib/browse-request'
import { mediaHandoff } from '@/lib/media/media-handoff'
import { traceUploadRequest, uploadRequestStep } from '@/lib/upload/upload-request-trace'
import { fetchMedia } from '@/lib/media/media-fetch'
import { lookupMedia } from '@/lib/media/media-lookup'
import { trackAction } from '@/lib/observability/activity-action'
import { requireAuth } from '@/lib/identity/auth'
import { HttpError, integer, PRIVATE_NO_STORE } from '@/lib/http'
import { route } from '@/lib/route'
import { getPresignedUrl, invalidateMediaUrl, validateStagePath } from '@/lib/media/image-urls'

export const dynamic = 'force-dynamic'
const TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
}
function validateRange(range: string | null): string | null {
  if (range && (!/^bytes=(\d+-\d*|-\d+)$/.test(range) || range.length > 80))
    throw new HttpError(416, 'Invalid range')
  return range
}
export const GET = withBrowseRequest(
  traceUploadRequest(
    route({ errorHeaders: PRIVATE_NO_STORE }, async (req: Request) => {
      await uploadRequestStep('media-auth', () => requireAuth())
      const url = new URL(req.url)
      const path = validateStagePath(url.searchParams.get('path'))
      // Cached signed URLs are never authority: validate against the live catalog on every request.
      const photo = await uploadRequestStep('media-lookup', () => lookupMedia(path))
      if (!photo) throw new HttpError(404, 'Media not found')
      const expiration = integer(url.searchParams.get('exp') ?? 3600, 'expiration', 60, 7200)
      const range = validateRange(req.headers.get('range'))
      const cacheThumbnail = photo.thumbnail_stage_path === path && isThumbnailRequest(req, path)
      const validator = cacheThumbnail ? thumbnailValidator(req) : null
      if (url.searchParams.get('download') !== '1') {
        const handoff = mediaHandoff(
          req,
          path,
          TYPES[path.split('.').pop()!.toLowerCase()] || 'application/octet-stream',
          cacheThumbnail,
        )
        if (handoff) return handoff
      }
      const rangeHeaders: HeadersInit | undefined = range
        ? { Range: range }
        : validator
          ? { 'If-None-Match': validator }
          : undefined
      const fetchImage = async () => {
        const signedUrl = await uploadRequestStep('media-presign', () =>
          getPresignedUrl(path, expiration),
        )
        return uploadRequestStep('media-fetch-headers', () =>
          fetchMedia(signedUrl, rangeHeaders, req.signal),
        )
      }
      let upstream = await fetchImage()
      if (upstream.status === 403) {
        await upstream.body?.cancel()
        invalidateMediaUrl(path)
        upstream = await fetchImage()
      }
      if (![200, 206, 416].includes(upstream.status) && !(validator && upstream.status === 304)) {
        await upstream.body?.cancel()
        throw new HttpError(upstream.status === 404 ? 404 : 502, 'Media unavailable')
      }
      const headers = new Headers({
        'Content-Type': TYPES[path.split('.').pop()!.toLowerCase()] || 'application/octet-stream',
        'Cache-Control':
          cacheThumbnail && [200, 304].includes(upstream.status)
            ? THUMBNAIL_CACHE_CONTROL
            : 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      for (const name of [
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'last-modified',
      ]) {
        const value = upstream.headers.get(name)
        if (
          value &&
          !(upstream.status === 304 && ['content-length', 'content-range'].includes(name))
        )
          headers.set(name, value)
      }
      if (
        url.searchParams.get('download') === '1' &&
        path === photo.original_stage_path &&
        upstream.status === 200 &&
        !range
      ) {
        trackAction('download_requested', `photo:${photo.photo_id}`, {
          files: 1,
          bytes: Number(photo.file_size_bytes ?? 0),
          scope: 'original',
        })
        headers.set(
          'Content-Disposition',
          `attachment; filename="photo-${photo.photo_id}.${path
            .split('.')
            .pop()!
            .replace(/[^a-zA-Z0-9]/g, '')}"`,
        )
      }
      return new Response(upstream.status === 304 ? null : upstream.body, {
        status: upstream.status,
        headers,
      })
    }),
  ),
)
