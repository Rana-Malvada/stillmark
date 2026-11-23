import { withDatabaseRequest } from '@/lib/database/database-context'
import { albumMutation, requireAlbumAccess, requirePhotosAccess } from '@/lib/albums/album-access'
import { trackAction } from '@/lib/observability/activity-action'
import { requireAuth, requireSameOrigin } from '@/lib/identity/auth'
import { integer, jsonBody } from '@/lib/http'
import { route } from '@/lib/route'
import { bulkPhotos, photoIds } from '@/lib/photos/photo-management'

export const POST = withDatabaseRequest(
  route(async (req: Request) => {
    await requireAuth()
    await requireSameOrigin()
    const body = await jsonBody(req)
    const result = await albumMutation(async (c) => {
      const ids = photoIds(body.ids)
      // Favorites are shared photo metadata, so every bulk action requires write access.
      await requirePhotosAccess(ids, true, c)
      const destination = body.action === 'move' ? integer(body.eventId, 'eventId') : undefined
      if (destination) await requireAlbumAccess(destination, true, c)
      return bulkPhotos(ids, String(body.action), destination)
    })
    trackAction('bulk_action', String(body.action))
    return Response.json(result)
  }),
)
