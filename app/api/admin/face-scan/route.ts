import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireMainAdmin } from '@/lib/albums/album-access'
import { requireSameOrigin } from '@/lib/identity/auth'
import { HttpError, jsonBody } from '@/lib/http'
import { route } from '@/lib/route'
import { scanStatus, startScan, stopScan } from '@/lib/people/face-scan'

export const dynamic = 'force-dynamic'
export const GET = withDatabaseRequest(
  route(async () => {
    await requireMainAdmin()
    return Response.json(await scanStatus(), { headers: { 'Cache-Control': 'no-store' } })
  }),
)
export const POST = withDatabaseRequest(
  route(async (req: Request) => {
    const caller = await requireMainAdmin()
    await requireSameOrigin()
    const { action } = await jsonBody(req)
    if (action === 'start') return Response.json(await startScan(caller.username))
    if (action === 'stop') return Response.json(await stopScan())
    throw new HttpError(400, 'Invalid action')
  }),
)
