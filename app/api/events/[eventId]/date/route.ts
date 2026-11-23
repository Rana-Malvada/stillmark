import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireSameOrigin } from '@/lib/identity/auth'
import { integer, jsonBody } from '@/lib/http'
import { route } from '@/lib/route'
import { applyAlbumDate } from '@/lib/albums/album-date'
import { trackAction } from '@/lib/observability/activity-action'

export const PATCH = withDatabaseRequest(
  route(async (req: Request, { params }: { params: Promise<{ eventId: string }> }) => {
    await requireSameOrigin()
    const id = integer((await params).eventId, 'eventId')
    const body = await jsonBody(req)
    const result = await applyAlbumDate(id, body.date, body.scope)
    trackAction('album_date_set', `album:${id}`, { files: result.count })
    return Response.json(result)
  }),
)
