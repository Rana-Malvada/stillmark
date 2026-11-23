import { withDatabaseRequest } from '@/lib/database/database-context'
import { albumMutation, requirePhotoAccess } from '@/lib/albums/album-access'
import { trackAction } from '@/lib/observability/activity-action'
import { requireSameOrigin } from '@/lib/identity/auth'
import { integer, jsonBody } from '@/lib/http'
import { route } from '@/lib/route'
import { updatePhotoLabels } from '@/lib/photos/photo-labels'

export const PATCH = withDatabaseRequest(
  route(async (req: Request, { params }: { params: Promise<{ photoId: string }> }) => {
    await requireSameOrigin()
    const { photoId } = await params
    const body = await jsonBody(req)
    const result = await albumMutation(
      async (c) => {
        await requirePhotoAccess(integer(photoId, 'photoId'), true, c)
        return updatePhotoLabels(integer(photoId, 'photoId'), body)
      },
      { photoIds: [integer(photoId, 'photoId')] },
    )
    trackAction('labels_changed', `photo:${photoId}`)
    return Response.json(result)
  }),
)
