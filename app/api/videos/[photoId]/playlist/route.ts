import { withDatabaseRequest } from '@/lib/database/database-context'
import { requirePhotoAccess } from '@/lib/albums/album-access'
import { integer, PRIVATE_NO_STORE } from '@/lib/http'
import { route } from '@/lib/route'
import { getVideoPlayback } from '@/lib/video/video-playback'
import { adaptivePlaylist, videoPlaylist } from '@/lib/video/video-playlist'
import { getImageProxyUrl } from '@/lib/media/image-urls'

export const dynamic = 'force-dynamic'
export const GET = withDatabaseRequest(
  route(async (req: Request, c: { params: Promise<{ photoId: string }> }) => {
    const id = integer((await c.params).photoId, 'photoId')
    await requirePhotoAccess(id)
    const playback = await getVideoPlayback(id)
    if (!playback) return new Response(null, { status: 204, headers: PRIVATE_NO_STORE })
    const variant = new URL(req.url).searchParams.get('variant')
    const rendition = playback.renditions.find((r) => r.name === variant)
    if (variant && !rendition) return new Response('Unknown rendition', { status: 404 })
    const manifest = rendition
      ? videoPlaylist(rendition.playlist, getImageProxyUrl(rendition.stage_path))
      : adaptivePlaylist(
          playback.renditions,
          (name) => `/api/videos/${id}/playlist?variant=${name}`,
        )
    return new Response(manifest, {
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'private, no-store',
      },
    })
  }),
)
