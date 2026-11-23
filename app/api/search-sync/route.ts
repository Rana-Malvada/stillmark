import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireMainAdmin } from '@/lib/albums/album-access'
import { requireSameOrigin } from '@/lib/identity/auth'
import { jsonBody } from '@/lib/http'
import { route } from '@/lib/route'
import { syncSearch } from '@/lib/search/search-sync'

export const dynamic = 'force-dynamic'
export const POST = withDatabaseRequest(
  route(async (req: Request) => {
    await requireMainAdmin()
    await requireSameOrigin()
    const body = await jsonBody(req)
    const result = await syncSearch({ force: true, full: body.full === true })
    return Response.json(result ?? { busy: true, photos: { synced: 0 }, events: { synced: 0 } })
  }),
)
