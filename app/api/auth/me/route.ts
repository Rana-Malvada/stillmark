import { accountDisplayName } from '@/lib/identity/account-display-name'
import { traceUploadRequest } from '@/lib/upload/upload-request-trace'
import { withDatabaseRequest } from '@/lib/database/database-context'
import { albumCaller, canManagePersonal } from '@/lib/albums/album-access'
import { hasAccessManagerRole, requireAuth } from '@/lib/identity/auth'
import { route } from '@/lib/route'

export const dynamic = 'force-dynamic'

export const GET = withDatabaseRequest(
  traceUploadRequest(
    route({ tag: 'auth/me' }, async () => {
      await requireAuth()
      const identity = await albumCaller()
      return Response.json({
        authenticated: true,
        username: identity.username,
        displayName: await accountDisplayName(identity.username),
        role: identity.role,
        canManagePersonal: canManagePersonal(identity),
        mainAdmin: identity.mainAdmin,
        canManageAccess: await hasAccessManagerRole(),
      })
    }),
  ),
)
