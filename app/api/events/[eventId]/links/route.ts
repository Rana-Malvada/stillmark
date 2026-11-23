import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireSameOrigin } from '@/lib/identity/auth'
import { HttpError, integer, jsonBody } from '@/lib/http'
import { route } from '@/lib/route'
import { createPublicLink, listPublicLinks, revokePublicLink } from '@/lib/albums/public-albums'

type Context = { params: Promise<{ eventId: string }> }
export const GET = withDatabaseRequest(
  route(async (_: Request, c: Context) => {
    return Response.json(await listPublicLinks(integer((await c.params).eventId, 'eventId')), {
      headers: { 'Cache-Control': 'no-store' },
    })
  }),
)
export const POST = withDatabaseRequest(
  route(async (req: Request, c: Context) => {
    await requireSameOrigin()
    const b = await jsonBody(req)
    if (
      typeof b.expiresAt !== 'string' ||
      typeof b.allowDownloads !== 'boolean' ||
      (b.includeLocation !== undefined && typeof b.includeLocation !== 'boolean') ||
      (b.includePeople !== undefined && typeof b.includePeople !== 'boolean')
    )
      throw new HttpError(400, 'Invalid sharing options')
    return Response.json(
      await createPublicLink(
        integer((await c.params).eventId, 'eventId'),
        b.expiresAt,
        b.allowDownloads,
        b.includeLocation === true,
        b.includePeople === true,
        b.photoIds,
      ),
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }),
)
export const DELETE = withDatabaseRequest(
  route(async (req: Request, c: Context) => {
    await requireSameOrigin()
    const b = await jsonBody(req)
    if (typeof b.id !== 'string' || !/^[a-f0-9-]{36}$/.test(b.id))
      throw new HttpError(400, 'Invalid link')
    await revokePublicLink(integer((await c.params).eventId, 'eventId'), b.id)
    return Response.json({ ok: true })
  }),
)
