import { requireAdminRead } from '@/lib/identity/auth'
import { withDatabaseRequest } from '@/lib/database/database-context'
import { listSharedLinks } from '@/lib/albums/public-albums'
import { HttpError } from '@/lib/http'
import { route } from '@/lib/route'

export const GET = withDatabaseRequest(
  route(async (req: Request) => {
    await requireAdminRead()
    const q = new URL(req.url).searchParams
    const status = q.get('status') || 'all'
    const page = Number(q.get('page') || 0)
    if (
      !['all', 'active', 'expired', 'revoked', 'invalidated'].includes(status) ||
      !Number.isSafeInteger(page) ||
      page < 0 ||
      page > 100000
    )
      throw new HttpError(400, 'Invalid filters')
    return Response.json(await listSharedLinks(q.get('owner') || '', status, page), {
      headers: { 'Cache-Control': 'no-store' },
    })
  }),
)
