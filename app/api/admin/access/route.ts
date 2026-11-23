import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireAccessManager, requireAccessRead, requireSameOrigin } from '@/lib/identity/auth'
import { jsonBody } from '@/lib/http'
import { route } from '@/lib/route'
import {
  accessOverview,
  accessRequest,
  operationId,
  runAccessOperation,
} from '@/lib/access-management'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
export const GET = withDatabaseRequest(
  route({ errorHeaders: { 'Cache-Control': 'no-store' } }, async () => {
    await requireAccessRead()
    return Response.json(await accessOverview(), { headers })
  }),
)
export const POST = withDatabaseRequest(
  route({ errorHeaders: { 'Cache-Control': 'no-store' } }, async (req: Request) => {
    const caller = await requireAccessManager()
    await requireSameOrigin()
    const body = await jsonBody(req, 8192)
    return Response.json(
      await runAccessOperation(caller.username, operationId(body.operationId), accessRequest(body)),
      { headers },
    )
  }),
)
