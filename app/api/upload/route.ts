import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireAdmin, requireSameOrigin } from '@/lib/identity/auth'
import { route } from '@/lib/route'

export const dynamic = 'force-dynamic'
/** All UI uploads use the resumable chunk protocol. No server file paths accepted. */
export const POST = withDatabaseRequest(
  route(async () => {
    await requireAdmin()
    await requireSameOrigin()
    return Response.json(
      { error: 'Please refresh the app to use the current upload flow.' },
      { status: 410 },
    )
  }),
)
