import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireSameOrigin } from '@/lib/identity/auth'
import { integer, jsonBody } from '@/lib/http'
import { privateJson, route } from '@/lib/route'
import { getVideoAnalysis, requestVideoAnalysis } from '@/lib/video/video-analysis'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ photoId: string }> }
export const GET = withDatabaseRequest(
  route(async (_req: Request, { params }: Context) => {
    return privateJson(await getVideoAnalysis(integer((await params).photoId, 'photoId')))
  }),
)
export const POST = withDatabaseRequest(
  route(async (req: Request, { params }: Context) => {
    await requireSameOrigin()
    const body = await jsonBody(req, 1024)
    return Response.json(
      await requestVideoAnalysis(integer((await params).photoId, 'photoId'), body.rerun === true),
      { status: 202 },
    )
  }),
)
