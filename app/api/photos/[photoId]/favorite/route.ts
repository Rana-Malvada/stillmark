import { withDatabaseRequest } from '@/lib/database/database-context'
import { albumMutation, requirePhotoAccess } from '@/lib/albums/album-access'
import { trackAction } from '@/lib/observability/activity-action'
import { requireAuth, requireSameOrigin } from '@/lib/identity/auth'
import { integer } from '@/lib/http'
import { route } from '@/lib/route'
import { toggleFavorite } from '@/lib/photos'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ photoId: string }> }
export const POST = withDatabaseRequest(
  route({ tag: 'favorite' }, async (_req: Request, { params }: Context) => {
    await requireAuth()
    await requireSameOrigin()
    const { photoId } = await params
    const favorite = await albumMutation(
      async (c) => {
        await requirePhotoAccess(integer(photoId, 'photoId'), true, c)
        return toggleFavorite(integer(photoId, 'photoId'))
      },
      { photoIds: [integer(photoId, 'photoId')] },
    )
    trackAction('favorite_changed', `photo:${photoId}`)
    return Response.json({ favorite })
  }),
)
