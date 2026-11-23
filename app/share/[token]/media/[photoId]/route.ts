import { withPublicRequest } from '@/lib/public-request'
import { withPublicDatabase } from '@/lib/database/database-context'
import { publicAlbum, shareHeaders, tokenHash } from '@/lib/albums/public-albums'
import { mediaHandoff } from '@/lib/media/media-handoff'
import { fetchMedia } from '@/lib/media/media-fetch'
import { getPresignedUrl, invalidateMediaUrl } from '@/lib/media/image-urls'
import { HttpError, integer } from '@/lib/http'
import { readPublicPhotoMedia } from '@/lib/photos/public-photos'
import { getVideoPlayback } from '@/lib/video/video-playback'
import { adaptivePlaylist, videoPlaylist } from '@/lib/video/video-playlist'

export const dynamic = 'force-dynamic'
async function GETHandler(
  req: Request,
  c: { params: Promise<{ token: string; photoId: string }> },
) {
  try {
    const { token, photoId } = await c.params
    const link = await publicAlbum(token)
    const url = new URL(req.url)
    const p = await readPublicPhotoMedia(link, integer(photoId, 'photoId'))
    if (!p) throw new HttpError(404, 'Media unavailable')
    const kind = url.searchParams.get('kind') ?? 'display'
    if (!['thumbnail', 'display', 'original', 'playlist', 'segment'].includes(kind))
      throw new HttpError(400, 'Invalid media type')
    if (kind === 'original' && !link.allow_downloads)
      throw new HttpError(403, 'Original downloads are disabled')
    const stream =
      ['playlist', 'segment'].includes(kind) || (kind === 'display' && p.media_type === 'video')
        ? await getVideoPlayback(Number(photoId))
        : null
    const variant = url.searchParams.get('variant')
    const rendition = stream?.renditions.find((r) => r.name === variant)
    if (variant && !rendition) throw new HttpError(404, 'Unknown rendition')
    if (kind === 'playlist') {
      if (!stream) return new Response(null, { status: 204, headers: shareHeaders })
      return new Response(
        rendition
          ? videoPlaylist(
              rendition.playlist,
              `/share/${token}/media/${photoId}?kind=segment&variant=${rendition.name}`,
            )
          : adaptivePlaylist(
              stream.renditions,
              (name) => `/share/${token}/media/${photoId}?kind=playlist&variant=${name}`,
            ),
        { headers: { ...shareHeaders, 'Content-Type': 'application/vnd.apple.mpegurl' } },
      )
    }
    const displayPath =
      p.media_type === 'video'
        ? stream?.renditions.find((r) => r.name === '720')?.stage_path ||
          stream?.stage_path ||
          p.display_stage_path ||
          p.original_stage_path
        : p.display_stage_path
    const path =
      kind === 'segment'
        ? rendition?.stage_path
        : kind === 'original'
          ? p.original_stage_path
          : kind === 'thumbnail'
            ? p.thumbnail_stage_path
            : displayPath
    // A display/thumbnail alias must never bypass the original-download policy.
    if (path === p.original_stage_path && !link.allow_downloads)
      throw new HttpError(403, 'Original downloads are disabled; a prepared preview is required')
    if (!path) throw new HttpError(404, 'Preview unavailable')
    const range = req.headers.get('range')
    if (range && (!/^bytes=(\d+-\d*|-\d+)$/.test(range) || range.length > 80))
      throw new HttpError(416, 'Invalid range')
    const types: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
    }
    if (kind !== 'original') {
      const handoff = mediaHandoff(
        req,
        path,
        types[path.split('.').pop()!.toLowerCase()] || 'application/octet-stream',
      )
      if (handoff) return handoff
    }
    const rangeHeaders = range ? { Range: range } : undefined
    let response = await fetchMedia(await getPresignedUrl(path), rangeHeaders, req.signal)
    if (response.status === 403) {
      await response.body?.cancel()
      invalidateMediaUrl(path)
      response = await fetchMedia(await getPresignedUrl(path), rangeHeaders, req.signal)
    }
    if (![200, 206, 416].includes(response.status)) {
      await response.body?.cancel()
      throw new HttpError(502, 'Media unavailable')
    }
    // Recheck after fetching the upstream URL; never expose the signed storage URL.
    await publicAlbum(token).catch(async (e) => {
      await response.body?.cancel()
      throw e
    })

    const ext = path.split('.').pop()!.toLowerCase()
    const headers = new Headers({
      ...shareHeaders,
      'Content-Type': types[ext] || 'application/octet-stream',
    })
    for (const h of ['content-length', 'content-range', 'accept-ranges']) {
      const v = response.headers.get(h)
      if (v) headers.set(h, v)
    }
    if (kind === 'original')
      headers.set(
        'Content-Disposition',
        `attachment; filename="photo-${photoId}.${ext.replace(/[^a-z0-9]/g, '')}"`,
      )
    return new Response(response.body, { status: response.status, headers })
  } catch (e) {
    return new Response(e instanceof HttpError ? e.message : 'Media unavailable', {
      status: e instanceof HttpError ? e.status : 500,
      headers: shareHeaders,
    })
  }
}

async function publicHandler(...args: Parameters<typeof GETHandler>) {
  const { token } = await args[1].params
  try {
    return await withPublicDatabase(tokenHash(token), () => GETHandler(...args), args[0].signal)
  } catch {
    return new Response('This link is unavailable or has expired.', {
      status: 404,
      headers: shareHeaders,
    })
  }
}

export const GET = withPublicRequest(publicHandler)
