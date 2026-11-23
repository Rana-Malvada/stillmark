import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireAuth } from '@/lib/identity/auth'
import { route } from '@/lib/route'
import { auth0LogoutUrl } from '@/lib/identity/auth0-logout'

export const dynamic = 'force-dynamic'
export const GET = withDatabaseRequest(
  route(async () => {
    await requireAuth()
    return Response.json({ url: auth0LogoutUrl() }, { headers: { 'Cache-Control': 'no-store' } })
  }),
)
