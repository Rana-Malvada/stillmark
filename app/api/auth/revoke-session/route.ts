import { withDatabaseRequest } from '@/lib/database/database-context'
import { headers } from 'next/headers'
import { gatewaySession } from '@/lib/identity/gateway-auth'
import { revokeGatewaySession } from '@/lib/identity/session-revocation'
import { HttpError } from '@/lib/http'
import { route } from '@/lib/route'

export const dynamic = 'force-dynamic'
export const POST = withDatabaseRequest(
  route(async () => {
    // Only the fixed Snowflake gateway principal plus a verified server signature
    // can revoke its own asserted session. Never accept a session ID from a body.
    const assertion = (await gatewaySession(await headers()))?.assertion
    if (!assertion)
      throw new HttpError(401, 'Gateway authentication required', undefined, 'GATEWAY_AUTH_FAILED')
    await revokeGatewaySession(assertion.sid)
    return Response.json({ revoked: true }, { headers: { 'Cache-Control': 'no-store' } })
  }),
)
