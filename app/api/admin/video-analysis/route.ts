import { withDatabaseRequest } from '@/lib/database/database-context'
import { listAnalysisVideos } from '@/lib/video/video-analysis'
import { HttpError, integer } from '@/lib/http'
import { route } from '@/lib/route'

export const dynamic = 'force-dynamic'
export const GET = withDatabaseRequest(
  route(async (req: Request) => {
    const q = new URL(req.url).searchParams
    const query = q.get('q') || ''
    if (query.length > 200) throw new HttpError(400, 'Search is too long')
    return Response.json(
      await listAnalysisVideos(query, integer(q.get('page') || '0', 'page', 0, 10000)),
    )
  }),
)
