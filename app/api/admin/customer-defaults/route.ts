import { requireAccessManager, requireSameOrigin } from '@/lib/identity/auth'
import { withDatabaseRequest } from '@/lib/database/database-context'
import {
  readCustomerDefaultAllowances,
  setCustomerDefaultAllowances,
} from '@/lib/identity/account-customer'
import { HttpError, integer, jsonBody } from '@/lib/http'
import { privateJson, route } from '@/lib/route'
import { flagOn } from '@/lib/flags'

export const dynamic = 'force-dynamic'
async function authorize() {
  if (!flagOn('CUSTOMER_ACCOUNTS_ENABLED')) throw new HttpError(404, 'Not found')
  await requireAccessManager()
}
export const GET = withDatabaseRequest(
  route({ errorHeaders: { 'Cache-Control': 'no-store' } }, async () => {
    await authorize()
    return privateJson((await readCustomerDefaultAllowances()) ?? {})
  }),
)
export const PATCH = withDatabaseRequest(
  route({ errorHeaders: { 'Cache-Control': 'no-store' } }, async (req: Request) => {
    await authorize()
    await requireSameOrigin()
    const body = await jsonBody(req, 1024)
    await setCustomerDefaultAllowances(
      integer(body.uploads, 'files', 0, 1000000),
      integer(body.storageGiB, 'storage GiB', 0, 10240) * 1073741824,
    )
    return privateJson({ ok: true })
  }),
)
