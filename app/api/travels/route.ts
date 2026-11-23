import { withBrowseRequest } from '@/lib/browse-request'
import { requireAuth } from '@/lib/identity/auth'
import { HttpError } from '@/lib/http'
import { privateJson, route } from '@/lib/route'
import { addPlaceNames } from '@/lib/travel/travel-place-names'
import { travelStops, viewportClusters } from '@/lib/travel/travels'

export const dynamic = 'force-dynamic'
export const GET = withBrowseRequest(
  route(async (req: Request) => {
    await requireAuth()
    const params = new URL(req.url).searchParams
    const scope = params.get('scope') ?? 'mine'
    if (scope !== 'mine' && scope !== 'accessible') throw new HttpError(400, 'Invalid travel scope')
    if (params.get('view') === 'viewport')
      return privateJson({ clusters: await viewportClusters(scope, params) })
    return privateJson({ stops: await addPlaceNames(await travelStops(scope)) })
  }),
)
