import { readGalleryStatistics } from '@/lib/gallery-statistics'
import { withDatabaseRequest } from '@/lib/database/database-context'
import { accessibleAlbumIds, albumCaller, requireMainAdmin } from '@/lib/albums/album-access'
import { requireAdminRead, requireSameOrigin } from '@/lib/identity/auth'
import { HttpError, jsonBody } from '@/lib/http'
import { route } from '@/lib/route'
import {
  listAiFailures,
  listCleanupFailures,
  listRecentUploadFiles,
  readActivitySummary,
  readSearchSyncState,
  retryFailedCleanup,
} from '@/lib/observability/activity-status'

export const dynamic = 'force-dynamic'
export const GET = withDatabaseRequest(
  route(async () => {
    await requireAdminRead()
    const caller = await albumCaller()
    const ids = await accessibleAlbumIds(caller)
    const [summary, uploads, failures, cleanup, sync, statistics] = await Promise.all([
      readActivitySummary(),
      listRecentUploadFiles(ids),
      listAiFailures(ids),
      caller.mainAdmin ? listCleanupFailures() : Promise.resolve([]),
      readSearchSyncState(),
      readGalleryStatistics(),
    ])
    return Response.json({
      summary: {
        ...summary,
        pending_sync: statistics.pending_sync,
        pending_search_removals: statistics.pending_search_removals,
        pending_ai: statistics.photos_without_ai,
      },
      uploads,
      failures,
      cleanup,
      sync,
      asOf: new Date().toISOString(),
    })
  }),
)
export const POST = withDatabaseRequest(
  route(async (req: Request) => {
    await requireMainAdmin()
    await requireSameOrigin()
    const body = await jsonBody(req)
    if (body.action !== 'retry-cleanup') throw new HttpError(400, 'Invalid action')
    await retryFailedCleanup()
    return Response.json({ queued: true })
  }),
)
