import { pgTransaction } from '@/lib/postgres'
import { traceUploadRequest } from '@/lib/upload/upload-request-trace'
import { withBrowseRequest } from '@/lib/browse-request'
import {
  accessibleAlbumIds,
  albumCaller,
  albumMutation,
  requirePhotoAccess,
} from '@/lib/albums/album-access'
import { trackAction } from '@/lib/observability/activity-action'
import { requireAuth, requireSameOrigin } from '@/lib/identity/auth'
import { HttpError, integer } from '@/lib/http'
import { route } from '@/lib/route'
import {
  deletePhoto,
  getAdjacentFavorites,
  getAuthorizedPhoto,
  getPhotoViewerPage,
  getViewerPreloadPhotos,
} from '@/lib/photos'
import { getImageProxyUrl } from '@/lib/media/image-urls'
import { chooseCoverPhoto } from '@/lib/albums/events'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ photoId: string }> }
export const GET = withBrowseRequest(
  traceUploadRequest(
    route({ tag: 'photo' }, async (req: Request, { params }: Context) => {
      await requireAuth()
      // Authenticate before checkout. The album viewer is one reader statement; the
      // cross-album favorites viewer keeps its reads on one connection.
      const query = new URL(req.url).searchParams
      const result =
        query.get('context') !== 'favorites'
          ? await getPhotoViewerPage(
              integer((await params).photoId, 'photoId'),
              await albumCaller(),
              query,
            )
          : await pgTransaction(async () => {
              const { photoId } = await params
              const caller = await albumCaller()
              const access = await getAuthorizedPhoto(integer(photoId, 'photoId'), caller)
              if (!access) return null
              const { photo } = access
              const allowedIds = await accessibleAlbumIds(caller)
              const adjacent = await getAdjacentFavorites(photo.photoId, query, allowedIds, true)
              const candidates =
                photo.mediaType === 'photo'
                  ? await getViewerPreloadPhotos(
                      [adjacent.next, adjacent.next2, adjacent.prev],
                      allowedIds,
                    )
                  : []
              return {
                photo,
                canEdit: access.canEdit,
                adjacent,
                candidates,
                coverPhotoId: access.coverPhotoId,
              }
            })
      if (!result) throw new HttpError(404, 'Not found')
      const { photo, adjacent, candidates } = result
      const preload = [adjacent.next, adjacent.next2, adjacent.prev].flatMap((id) => {
        const p = candidates.find((p) => p.photo_id === id)
        return p
          ? [
              {
                photoId: p.photo_id,
                url: getImageProxyUrl(p.display_stage_path),
                width: p.width,
                height: p.height,
              },
            ]
          : []
      })
      return Response.json({
        ...photo,
        canEdit: result.canEdit,
        isAlbumCover: result.coverPhotoId === photo.photoId,
        displayUrl: photo.displayStagePath ? getImageProxyUrl(photo.displayStagePath) : null,
        originalUrl: photo.originalStagePath
          ? getImageProxyUrl(photo.originalStagePath, 7200)
          : null,
        prev: adjacent.prev,
        next: adjacent.next,
        preload,
      })
    }),
  ),
)

export const DELETE = withBrowseRequest(
  route({ tag: 'photo-delete' }, async (_req: Request, { params }: Context) => {
    await requireSameOrigin()
    const { photoId } = await params
    const result = await albumMutation(async (c) => {
      await requirePhotoAccess(integer(photoId, 'photoId'), true, c)
      return deletePhoto(integer(photoId, 'photoId'))
    })
    if (!result) throw new HttpError(404, 'Not found')
    trackAction('photo_trashed', `photo:${photoId}`)
    return Response.json({ ok: true, eventId: result.eventId })
  }),
)

export const PATCH = withBrowseRequest(
  route(async (_req: Request, { params }: Context) => {
    await requireSameOrigin()
    const { photoId } = await params
    if (
      !(await albumMutation(async (c) => {
        await requirePhotoAccess(integer(photoId, 'photoId'), true, c)
        return chooseCoverPhoto(integer(photoId, 'photoId'))
      }))
    )
      throw new HttpError(404, 'Photo is unavailable as an album cover')
    trackAction('cover_changed', `photo:${photoId}`)
    return Response.json({ ok: true })
  }),
)
