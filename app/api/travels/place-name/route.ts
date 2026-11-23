import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireAuth, requireSameOrigin } from '@/lib/identity/auth'
import { HttpError, jsonBody } from '@/lib/http'
import { privateJson, route } from '@/lib/route'
import { travelStops } from '@/lib/travel/travels'
import { areaId, lookupPlaceName } from '@/lib/travel/travel-place-names'

export const POST = withDatabaseRequest(
  route(async (req: Request) => {
    await requireAuth()
    await requireSameOrigin()
    const body = await jsonBody(req, 1024)
    if (typeof body.area !== 'string' || body.area.length > 40)
      throw new HttpError(400, 'Invalid area')
    if (body.retry !== undefined && typeof body.retry !== 'boolean')
      throw new HttpError(400, 'Invalid retry option')
    // Do not expose a general-purpose geocoder or leak private album locations.
    const stops = await travelStops('accessible')
    const stop = stops.find(
      (s) => s.lat !== null && s.lng !== null && areaId(s.lat, s.lng) === body.area,
    )
    if (!stop) throw new HttpError(404, 'Area not found')
    return privateJson(await lookupPlaceName(stop.lat!, stop.lng!, body.retry === true))
  }),
)
