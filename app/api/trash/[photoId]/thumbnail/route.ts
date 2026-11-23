import { withDatabaseRequest } from '@/lib/database/database-context'
import { albumCaller } from '@/lib/albums/album-access'
import { readTrashThumbnailPath } from '@/lib/photos/photo-trash'
import { HttpError, integer, PRIVATE_NO_STORE } from '@/lib/http'
import { route } from '@/lib/route'
import { getPresignedUrl, invalidateMediaUrl, validateStagePath } from '@/lib/media/image-urls'
import { fetchMedia } from '@/lib/media/media-fetch'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ photoId: string }> }
export const GET = withDatabaseRequest(
  route({ errorHeaders: PRIVATE_NO_STORE }, async (req: Request, context: Context) => {
    const caller = await albumCaller()
    const id = integer((await context.params).photoId, 'photoId')
    // Match Trash visibility, never normal album visibility or a client-supplied storage path.
    const stored = await readTrashThumbnailPath(id, caller)
    if (!stored) throw new HttpError(404, 'Preview unavailable')
    const path = validateStagePath(stored)
    const type = (
      { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as Record<
        string,
        string
      >
    )[path.split('.').pop()!.toLowerCase()]
    if (!type) throw new HttpError(404, 'Preview unavailable')
    let upstream = await fetchMedia(await getPresignedUrl(path, 3600), undefined, req.signal)
    if (upstream.status === 403) {
      await upstream.body?.cancel()
      invalidateMediaUrl(path)
      upstream = await fetchMedia(await getPresignedUrl(path, 3600), undefined, req.signal)
    }
    if (!upstream.ok) {
      await upstream.body?.cancel()
      throw new HttpError(404, 'Preview unavailable')
    }
    return new Response(upstream.body, {
      headers: {
        'Content-Type': type,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }),
)
