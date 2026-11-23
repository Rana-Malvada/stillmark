import { requireAuth, requireSameOrigin } from '@/lib/identity/auth'
import { withDatabaseRequest } from '@/lib/database/database-context'
import {
  readCustomerAccount,
  readMemberProfile,
  requestAccountDeletion,
  updateCustomerProfile,
} from '@/lib/identity/account-customer'
import { HttpError, jsonBody, textValue } from '@/lib/http'
import { privateJson, route } from '@/lib/route'
import { flagOn } from '@/lib/flags'

export const dynamic = 'force-dynamic'
async function enabled() {
  if (!flagOn('CUSTOMER_ACCOUNTS_ENABLED'))
    throw new HttpError(404, 'Account settings are not enabled yet')
  return requireAuth()
}
export const GET = withDatabaseRequest(
  route({ errorHeaders: { 'Cache-Control': 'no-store' } }, async () => {
    const caller = await requireAuth()
    if (!flagOn('CUSTOMER_ACCOUNTS_ENABLED')) {
      const profile = await readMemberProfile(caller.username)
      return privateJson({
        ...profile,
        displayName: profile?.displayName ?? caller.username,
        publicAccount: false,
      })
    }
    return privateJson((await readCustomerAccount()) ?? {})
  }),
)
export const PATCH = withDatabaseRequest(
  route({ errorHeaders: { 'Cache-Control': 'no-store' } }, async (req: Request) => {
    await enabled()
    await requireSameOrigin()
    const body = await jsonBody(req)
    await updateCustomerProfile(textValue(body.displayName, 'display name', 120))
    return privateJson({ ok: true })
  }),
)
export const DELETE = withDatabaseRequest(
  route({ errorHeaders: { 'Cache-Control': 'no-store' } }, async (req: Request) => {
    await enabled()
    await requireSameOrigin()
    const body = await jsonBody(req)
    if (body.confirmation !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm')
    await requestAccountDeletion()
    return privateJson({ ok: true })
  }),
)
