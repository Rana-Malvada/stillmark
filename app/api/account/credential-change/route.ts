import { headers } from 'next/headers'
import { withDatabaseRequest } from '@/lib/database/database-context'
import { gatewayAssertion } from '@/lib/identity/gateway-auth'
import { pgCredentialChange } from '@/lib/postgres'
import { HttpError } from '@/lib/http'
import { route } from '@/lib/route'
import { flagOn } from '@/lib/flags'

export const dynamic = 'force-dynamic'
export const POST = withDatabaseRequest(
  route({ errorHeaders: { 'Cache-Control': 'no-store' } }, async () => {
    if (!flagOn('CUSTOMER_ACCOUNTS_ENABLED')) throw new HttpError(404, 'Not found')
    const assertion = gatewayAssertion(await headers())
    const cutoff = assertion?.credentialChange
    if (
      !assertion ||
      !Number.isSafeInteger(cutoff) ||
      !cutoff ||
      cutoff < 1 ||
      cutoff > Date.now() / 1000 + 5
    )
      throw new HttpError(401, 'Invalid credential event', undefined, 'GATEWAY_AUTH_FAILED')
    await pgCredentialChange(assertion.sub, cutoff)
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
  }),
)
