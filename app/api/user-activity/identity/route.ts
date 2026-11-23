import { withDatabaseRequest } from '@/lib/database/database-context'
import {
  requireAccessManager,
  requireAccessRead,
  requireAdminRead,
  requireSameOrigin,
} from '@/lib/identity/auth'
import { HttpError, jsonBody } from '@/lib/http'
import { route } from '@/lib/route'
import { identityStatus, syncIdentity } from '@/lib/identity/identity-logs'
import { trackAction } from '@/lib/observability/activity-action'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store' }
export const GET = withDatabaseRequest(
  route(async () => {
    await requireAdminRead()
    await requireAccessRead()
    return Response.json(await identityStatus(), { headers })
  }),
)
export const POST = withDatabaseRequest(
  route(async (req: Request) => {
    await requireAdminRead()
    await requireAccessManager()
    await requireSameOrigin()
    const body = await jsonBody(req, 1024)
    if (body.provider !== 'auth0' && body.provider !== 'snowflake')
      throw new HttpError(400, 'Invalid provider')
    const result = await syncIdentity(body.provider)
    trackAction('identity_import', body.provider)
    return Response.json(result, { headers })
  }),
)
