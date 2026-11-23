import { requireAccessManager, requireSameOrigin } from '@/lib/identity/auth'
import { withDatabaseRequest } from '@/lib/database/database-context'
import { setCustomerAllowance } from '@/lib/identity/account-customer'
import { HttpError, integer, jsonBody, textValue } from '@/lib/http'
import { route } from '@/lib/route'
import { flagOn } from '@/lib/flags'

export const dynamic = 'force-dynamic'
export const POST = withDatabaseRequest(
  route({ errorHeaders: { 'Cache-Control': 'no-store' } }, async (req: Request) => {
    if (!flagOn('CUSTOMER_ACCOUNTS_ENABLED')) throw new HttpError(404, 'Not found')
    await requireAccessManager()
    await requireSameOrigin()
    const body = await jsonBody(req, 2048)
    await setCustomerAllowance(
      textValue(body.username, 'username', 100),
      integer(body.uploads, 'uploads', 0, 1000000),
      integer(body.bytes, 'bytes', 0, 10995116277760),
      integer(body.aiSearches ?? 0, 'daily AI searches', 0, 10000),
    )
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
  }),
)
