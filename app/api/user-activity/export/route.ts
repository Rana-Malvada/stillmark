import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireAccessRead, requireAdminRead } from '@/lib/identity/auth'
import { route } from '@/lib/route'
import { exportActivity, exportFilters } from '@/lib/observability/activity-exports'

export const dynamic = 'force-dynamic'
export const GET = withDatabaseRequest(
  route(async (req: Request) => {
    await requireAdminRead()
    await requireAccessRead()
    const filters = exportFilters(req)
    const csv = await exportActivity(filters)
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="gallery-${filters.mode}.csv"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }),
)
