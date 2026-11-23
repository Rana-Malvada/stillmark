import { requirePagedList } from '@/lib/albums/bounded-list-api'
import { thumbnailGrantUrls } from '@/lib/media/thumbnail-grant-urls'
import { traceUploadRequest } from '@/lib/upload/upload-request-trace'
import { withBrowseRequest } from '@/lib/browse-request'
import { requireFolderWrite } from '@/lib/albums/folders'
import { albumCaller, canEditAlbum } from '@/lib/albums/album-access'
import { requireAuth } from '@/lib/identity/auth'
import { integer } from '@/lib/http'
import { privateJson, route } from '@/lib/route'

export const dynamic = 'force-dynamic'

export const GET = withBrowseRequest(
  traceUploadRequest(
    route({ tag: 'events-with-covers' }, async (req: Request) => {
      await requireAuth()
      const caller = await albumCaller()
      const params = new URL(req?.url ?? 'https://app/api/events').searchParams
      requirePagedList(params)
      const { albumPage } = await import('@/lib/albums/album-page')
      const page = await albumPage(caller, params)
      const thumbnails = await thumbnailGrantUrls(
        req,
        page.items.map((e) => e.coverThumbnailPath),
      )
      return privateJson({
        ...page,
        items: page.items.map((e, index) => ({
          ...e,
          canEdit: canEditAlbum(caller, e.ownerUsername),
          coverUrl: thumbnails[index],
        })),
      })
    }),
  ),
)

export const POST = withBrowseRequest(
  route(async (req: Request) => {
    const { requireSameOrigin } = await import('@/lib/identity/auth')
    await requireSameOrigin()
    const { requireUploadUser, albumMutation } = await import('@/lib/albums/album-access')
    await requireUploadUser()
    const { jsonBody, textValue } = await import('@/lib/http')
    const body = await jsonBody(req, 4096)
    const { createEvent } = await import('@/lib/albums/events')
    const { randomUUID } = await import('node:crypto')
    const eventId = await albumMutation(async (c) => {
      const folderId = body.folderId == null ? null : integer(body.folderId, 'folderId')
      if (folderId !== null) await requireFolderWrite(folderId, c)
      return createEvent({
        folderId,
        ownerUsername: c.username,
        eventName: textValue(body.eventName, 'eventName'),
        sourceFolder: `album/${randomUUID()}`,
        sortOrder: 0,
        eventMonth: null,
        eventYear: null,
        location: null,
      })
    })
    return Response.json({ eventId }, { status: 201 })
  }),
)
