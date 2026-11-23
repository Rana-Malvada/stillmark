import { activityIdentities } from '@/lib/observability/user-activity'
import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireAccessRead, requireAdminRead } from '@/lib/identity/auth'
import { route } from '@/lib/route'
import { exportFilters, summaryReport } from '@/lib/observability/activity-exports'

export const dynamic = 'force-dynamic'
export const GET = withDatabaseRequest(
  route(async (req: Request) => {
    await requireAdminRead()
    await requireAccessRead()
    const url = new URL(req.url)
    url.searchParams.set('mode', 'summary')
    const f = exportFilters(new Request(url))
    const rows = await summaryReport(f.user, f.kind, f.days)
    return Response.json(
      {
        rows: await activityIdentities(
          rows.slice(0, 1000) as (Record<string, unknown> & { username: string })[],
        ),
        more: rows.length > 1000,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }),
)
