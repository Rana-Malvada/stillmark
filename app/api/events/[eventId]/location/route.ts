import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireSameOrigin } from '@/lib/identity/auth'
import { HttpError, integer, jsonBody } from '@/lib/http'
import { privateJson, route } from '@/lib/route'
import {
  applyAlbumLocation,
  locationStatus,
  requireLocationEditor,
  undoAlbumLocation,
} from '@/lib/albums/album-location'
import { searchPlaces } from '@/lib/travel/place-search'
import { trackAction } from '@/lib/observability/activity-action'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ eventId: string }> }
export const GET = withDatabaseRequest(
  route(async (_req: Request, { params }: Context) => {
    return privateJson(await locationStatus(integer((await params).eventId, 'eventId')))
  }),
)
export const POST = withDatabaseRequest(
  route(async (req: Request, { params }: Context) => {
    await requireSameOrigin()
    const id = integer((await params).eventId, 'eventId')
    const body = await jsonBody(req)
    await requireLocationEditor(id)
    if (body.action === 'search') return privateJson({ places: await searchPlaces(body.query) })
    if (body.action !== 'apply' && body.action !== 'undo')
      throw new HttpError(400, 'Invalid action')
    const result =
      body.action === 'undo'
        ? await undoAlbumLocation(id, body.id)
        : await applyAlbumLocation(id, body.place)
    trackAction(
      body.action === 'undo' ? 'album_location_undone' : 'album_location_set',
      `album:${id}`,
      { files: result.count },
    )
    return Response.json(result)
  }),
)
