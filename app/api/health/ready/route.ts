import { withAnonymousDatabase, withDatabaseRequest } from '@/lib/database/database-context'
import { requireAdmin } from '@/lib/identity/auth'
import { apiError } from '@/lib/http'
import { probeRequiredSchema } from '@/lib/database/postgres-health'

export const dynamic = 'force-dynamic'
async function GETHandler() {
  try {
    await requireAdmin()
    await probeRequiredSchema()
    return Response.json({ status: 'ready' })
  } catch (error) {
    console.error('[readiness]', error)
    const response = apiError(error)
    return response.status === 500
      ? Response.json({ status: 'unavailable' }, { status: 503 })
      : response
  }
}

export const GET = withDatabaseRequest(() => withAnonymousDatabase(GETHandler))
