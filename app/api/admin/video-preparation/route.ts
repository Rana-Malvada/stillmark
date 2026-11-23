import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireMainAdmin } from '@/lib/albums/album-access'
import { requireSameOrigin } from '@/lib/identity/auth'
import { HttpError, integer, jsonBody } from '@/lib/http'
import { route } from '@/lib/route'
import {
  preparationStatus,
  setPreparationSkipped,
  startPreparation,
} from '@/lib/video/video-preparation'

export const dynamic = 'force-dynamic'
export const GET = withDatabaseRequest(
  route(async () => {
    await requireMainAdmin()
    return Response.json(await preparationStatus(), { headers: { 'Cache-Control': 'no-store' } })
  }),
)
export const POST = withDatabaseRequest(
  route(async () => {
    const caller = await requireMainAdmin()
    await requireSameOrigin()
    return Response.json(await startPreparation(caller.username))
  }),
)

export const PATCH = withDatabaseRequest(
  route(async (req: Request) => {
    await requireMainAdmin()
    await requireSameOrigin()
    const body = await jsonBody(req)
    if (typeof body.skipped !== 'boolean') throw new HttpError(400, 'Invalid skipped flag')
    return Response.json(
      await setPreparationSkipped(integer(body.photoId, 'photo ID'), body.skipped),
    )
  }),
)
