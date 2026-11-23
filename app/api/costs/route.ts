import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireAdmin, requireAdminRead, requireSameOrigin } from '@/lib/identity/auth'
import { route } from '@/lib/route'
import { costRefreshProgress, refreshCostReport, storedCostReport } from '@/lib/costs/cost-report'

export const dynamic = 'force-dynamic'
export const GET = withDatabaseRequest(
  route(async (req: Request) => {
    const caller = await requireAdminRead()
    if (req && new URL(req.url).searchParams.get('progress') === '1')
      return Response.json(await costRefreshProgress())
    return Response.json(await storedCostReport(caller.role !== 'admin_readonly'))
  }),
)
export const POST = withDatabaseRequest(
  route(async () => {
    await requireAdmin()
    await requireSameOrigin()
    const report = await refreshCostReport()
    // The browser reads scoped totals separately; do not return the entire raw ledger.
    return Response.json({ asOf: report.asOf })
  }),
)
