import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireAuth } from '@/lib/identity/auth'
import { route } from '@/lib/route'
import { deployment } from '@/config/deployment.mjs'
import { mapTile } from '@/lib/map-tiles.mjs'

export const GET = withDatabaseRequest(
  route(async (req: Request) => {
    await requireAuth()
    return await mapTile(req, deployment.GATEWAY_ORIGIN)
  }),
)
