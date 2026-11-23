import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireMainAdmin } from '@/lib/albums/album-access'
import { requireSameOrigin } from '@/lib/identity/auth'
import { HttpError, integer, jsonBody } from '@/lib/http'
import { route } from '@/lib/route'
import { retryAutomaticSearch } from '@/lib/search/automatic-search'
import {
  retrySearchFollowup,
  searchBatchStatus,
  startSearchBatch,
  stopSearchBatch,
} from '@/lib/search/search-batch'

export const dynamic = 'force-dynamic'
export const GET = withDatabaseRequest(
  route(async () => {
    await requireMainAdmin()
    return Response.json(await searchBatchStatus())
  }),
)
export const POST = withDatabaseRequest(
  route(async (req: Request) => {
    const user = await requireMainAdmin()
    await requireSameOrigin()
    const body = await jsonBody(req)
    if (body.action === 'retry-publishing') return Response.json(await retryAutomaticSearch())
    if (body.action === 'retry-followup') {
      if (typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.id))
        throw new HttpError(400, 'Invalid run ID')
      return Response.json(await retrySearchFollowup(body.id))
    }
    if (body.action === 'stop') return Response.json(await stopSearchBatch())
    return Response.json(
      await startSearchBatch(
        user.username,
        integer(body.photoLimit ?? 100000, 'photoLimit', 0, 100000),
        integer(body.searchLimit ?? 20, 'searchLimit', 0, 1000),
      ),
    )
  }),
)
