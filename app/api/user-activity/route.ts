import { withDatabaseRequest } from '@/lib/database/database-context'
import { cookies } from 'next/headers'
import { randomUUID } from 'node:crypto'
import {
  requireAccessRead,
  requireAdminRead,
  requireAuth,
  requireSameOrigin,
} from '@/lib/identity/auth'
import { HttpError, integer, jsonBody } from '@/lib/http'
import { route } from '@/lib/route'
import { activityReport, parseViews, recordViews, UUID } from '@/lib/observability/user-activity'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store' }
export const POST = withDatabaseRequest(
  route(async (req: Request) => {
    const caller = await requireAuth()
    await requireSameOrigin()
    const body = await jsonBody(req, 8192)
    const views = parseViews(body.events)
    const jar = await cookies()
    const candidate = jar.get('gallery_activity')?.value ?? ''
    const session = await recordViews(
      caller.username,
      UUID.test(candidate) ? candidate : randomUUID(),
      views,
    )
    jar.set('gallery_activity', session, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 1800,
    })
    return Response.json({ ok: true }, { headers })
  }),
)
export const GET = withDatabaseRequest(
  route(async (req: Request) => {
    await requireAdminRead()
    await requireAccessRead()
    const q = new URL(req.url).searchParams
    const user = q.get('user') ?? ''
    const kind = q.get('kind') ?? ''
    if (user.length > 255 || !/^[a-z_]{0,50}$/.test(kind))
      throw new HttpError(400, 'Invalid filter')
    const days = integer(q.get('days') ?? 30, 'days', 1, 90)
    const time = q.get('before')
    const id = q.get('beforeId')
    if ((time || id) && (!time || !id || !UUID.test(id) || !Number.isFinite(Date.parse(time))))
      throw new HttpError(400, 'Invalid cursor')
    return Response.json(
      await activityReport(user, kind, days, time && id ? { time, id } : undefined),
      { headers },
    )
  }),
)
