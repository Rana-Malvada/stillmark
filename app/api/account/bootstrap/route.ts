import { deployment } from '@/config/deployment.mjs'
import { headers } from 'next/headers'
import { withDatabaseRequest } from '@/lib/database/database-context'
import { gatewayAssertion } from '@/lib/identity/gateway-auth'
import { pgRegisterCustomer } from '@/lib/postgres'
import { apiError, HttpError } from '@/lib/http'
import { postgresPermissionsEnabled } from '@/lib/permission-authority'
import { flagOn } from '@/lib/flags'

export const dynamic = 'force-dynamic'
export const POST = withDatabaseRequest(async () => {
  try {
    if (!flagOn('CUSTOMER_ACCOUNTS_ENABLED') || !postgresPermissionsEnabled())
      throw new HttpError(404, 'Not found')
    const assertion = gatewayAssertion(await headers())
    const claims = assertion?.onboarding
    if (
      !assertion ||
      !claims ||
      claims.issuer !== `https://${deployment.AUTH0_DOMAIN}/` ||
      typeof claims.email !== 'string' ||
      claims.email.length > 254 ||
      typeof claims.displayName !== 'string' ||
      claims.displayName.length > 120 ||
      typeof claims.verified !== 'boolean'
    )
      throw new HttpError(401, 'Invalid account identity', undefined, 'GATEWAY_AUTH_FAILED')
    await pgRegisterCustomer(assertion.sub, claims, assertion.jti, assertion.exp)
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const response =
      error instanceof HttpError
        ? apiError(error)
        : Response.json(
            {
              error:
                'Account registration unavailable. Verify your email or contact the administrator.',
            },
            { status: 403 },
          )
    response.headers.set('Cache-Control', 'no-store')
    return response
  }
})
