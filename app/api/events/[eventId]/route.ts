import { requirePagedList } from '@/lib/albums/bounded-list-api'
import { thumbnailGrantUrls } from '@/lib/media/thumbnail-grant-urls'
import { pgReadIdentity } from '@/lib/postgres'
import { traceUploadRequest } from '@/lib/upload/upload-request-trace'
import { withBrowseRequest } from '@/lib/browse-request'
import { authorizedPhotoPage } from '@/lib/photos/photo-page'
import { requireFolderWrite } from '@/lib/albums/folders'
import { albumCaller, albumMutation, requireAlbumAccess } from '@/lib/albums/album-access'
import { trackAction } from '@/lib/observability/activity-action'
import { requireAuth, requireSameOrigin } from '@/lib/identity/auth'
import { apiError, integer, jsonBody, PRIVATE_NO_STORE } from '@/lib/http'
import { privateJson, route } from '@/lib/route'
import { deleteEvent, updateAlbumDetails } from '@/lib/albums/events'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ eventId: string }> }
async function HEADHandler(_req: Request, { params }: Context) {
  try {
    await requireAuth()
    await requireAlbumAccess(integer((await params).eventId, 'eventId'))
    return new Response(null, { status: 200, headers: PRIVATE_NO_STORE })
  } catch (error) {
    const response = apiError(error)
    return new Response(null, {
      status: response.status,
      headers: PRIVATE_NO_STORE,
    })
  }
}

export const GET = withBrowseRequest(
  traceUploadRequest(
    route({ tag: 'event-photos' }, async (req: Request, { params }: Context) => {
      await requireAuth()
      const { eventId } = await params
      const id = integer(eventId, 'eventId')
      const searchParams = new URL(req.url).searchParams
      requirePagedList(searchParams)
      const caller = await albumCaller()
      const page = await pgReadIdentity(
        caller,
        () => authorizedPhotoPage(id, searchParams, caller),
        {
          singleQuery: true,
          disableJit: true,
        },
      )
      // Release the database connection before URL mapping and JSON serialization.
      const thumbnails = await thumbnailGrantUrls(
        req,
        page.items.map((p) => p.thumbnailStagePath),
      )
      return privateJson({
        ...page,
        items: page.items.map((p, index) => ({
          ...p,
          thumbnailUrl: thumbnails[index],
        })),
      })
    }),
  ),
)

export const DELETE = withBrowseRequest(
  route({ tag: 'event-delete' }, async (_req: Request, { params }: Context) => {
    await requireSameOrigin()
    const { eventId } = await params
    await albumMutation(async (c) => {
      await requireAlbumAccess(integer(eventId, 'eventId'), true, c)
      await deleteEvent(integer(eventId, 'eventId'))
    })
    trackAction('album_trashed', `album:${eventId}`)
    return Response.json({ ok: true })
  }),
)

export const PATCH = withBrowseRequest(
  route({ tag: 'event-update' }, async (req: Request, { params }: Context) => {
    await requireSameOrigin()
    const { eventId } = await params
    const body = await jsonBody(req)
    await albumMutation(async (c) => {
      await requireAlbumAccess(integer(eventId, 'eventId'), true, c)
      if (body.folderId != null) await requireFolderWrite(integer(body.folderId, 'folderId'), c)
      await updateAlbumDetails(integer(eventId, 'eventId'), body)
    })
    trackAction('album_changed', `album:${eventId}`)
    return Response.json({ ok: true })
  }),
)

export const HEAD = withBrowseRequest(HEADHandler)
