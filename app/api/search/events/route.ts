import { pagedSearch } from '@/lib/search/search-session'
import { withSearchRequest } from '@/lib/search/search-request'
import { accessibleAlbumIds } from '@/lib/albums/album-access'
import { requireAuth } from '@/lib/identity/auth'
import { apiError, HttpError } from '@/lib/http'
import { searchOptions } from '@/lib/search'
import { loggedSearchQuery } from '@/lib/people/people-search'
import { trackAction } from '@/lib/observability/activity-action'

export const dynamic = 'force-dynamic'
async function GETHandler(req: Request) {
  let options: ReturnType<typeof searchOptions> | undefined
  const started = performance.now()
  try {
    await requireAuth()
    options = searchOptions(req)
    const result = await pagedSearch('event', req, await accessibleAlbumIds())
    if (options.query)
      trackAction('search_performed', '', {
        // Activity logs never store the names of recognised people.
        query: loggedSearchQuery(options.query, result),
        scope: 'event',
        mode: String(result.source),
        outcome: 'success',
        results: result.count,
        durationMs: Math.round(performance.now() - started),
      })
    return Response.json(result)
  } catch (error) {
    if (options?.query)
      trackAction('search_performed', '', {
        query: '[search failed]',
        scope: 'event',
        mode: options.semantic ? 'semantic' : 'auto',
        outcome: 'failed',
        status: error instanceof HttpError ? error.status : 500,
        durationMs: Math.round(performance.now() - started),
      })
    return apiError(error)
  }
}

export const GET = withSearchRequest(GETHandler)
