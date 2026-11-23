import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireSameOrigin } from '@/lib/identity/auth'
import {
  albumCaller,
  albumMutation,
  requireAlbumAccess,
  requireTrashAccess,
} from '@/lib/albums/album-access'
import { HttpError, integer, jsonBody } from '@/lib/http'
import { route } from '@/lib/route'
import { listTrashPage, listTrashPhotoIds, trashedPhotoAlbumIds } from '@/lib/photos/photo-trash'
import { permanentlyDeleteTrash, photoIds, restorePhotos } from '@/lib/photos/photo-management'

export const dynamic = 'force-dynamic'
export const GET = withDatabaseRequest(
  route(async (req: Request) => {
    const c = await albumCaller()
    const page = integer(new URL(req.url).searchParams.get('page') ?? 1, 'page', 1, 100000)
    const rows = await listTrashPage((page - 1) * 100, c)
    return Response.json(
      { files: rows.slice(0, 100), hasMore: rows.length > 100 },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }),
)
export const POST = withDatabaseRequest(
  route(async (req: Request) => {
    await requireSameOrigin()
    const body = await jsonBody(req)
    const ids = photoIds(body.ids)
    const destination = body.eventId ? integer(body.eventId, 'eventId') : undefined
    return Response.json(
      await albumMutation(async (c) => {
        await requireTrashAccess(ids, c)
        const albums = await trashedPhotoAlbumIds(ids)
        for (const id of destination ? [destination] : albums) await requireAlbumAccess(id, true, c)
        return restorePhotos(ids, destination)
      }),
    )
  }),
)
export const DELETE = withDatabaseRequest(
  route(async (req: Request) => {
    await requireSameOrigin()
    const body = await jsonBody(req)
    if (body.confirm !== 'PERMANENTLY_DELETE')
      throw new HttpError(400, 'Permanent deletion requires confirmation')
    const result = await albumMutation(async (c) => {
      const ids = body.all === true ? await listTrashPhotoIds(c) : photoIds(body.ids)
      await requireTrashAccess(ids, c)
      return permanentlyDeleteTrash(ids)
    })
    return Response.json({ ...result, storageCleanup: 'queued' })
  }),
)
