import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireMainAdmin } from '@/lib/albums/album-access'
import { requireSameOrigin } from '@/lib/identity/auth'
import { HttpError, jsonBody } from '@/lib/http'
import { route } from '@/lib/route'
import { requestUploadMode, uploadRoutingStatus } from '@/lib/upload/upload-routing'

export const dynamic = 'force-dynamic'
export const GET = withDatabaseRequest(
  route(async () => {
    await requireMainAdmin()
    return Response.json(await uploadRoutingStatus(), { headers: { 'Cache-Control': 'no-store' } })
  }),
)
export const POST = withDatabaseRequest(
  route(async (req: Request) => {
    const user = await requireMainAdmin()
    await requireSameOrigin()
    if (process.env.UPLOAD_ROUTING_MANAGED !== 'true')
      throw new HttpError(409, 'Managed upload routing is not enabled yet')
    const body = await jsonBody(req)
    if (body.mode !== 'pool') throw new HttpError(400, 'Invalid upload mode')
    return Response.json(await requestUploadMode(body.mode, user.username), {
      headers: { 'Cache-Control': 'no-store' },
    })
  }),
)
