import { accountDisplayName } from '@/lib/identity/account-display-name'
import { albumCaller, canManagePersonal } from '@/lib/albums/album-access'
import { hasAccessManagerRole } from '@/lib/identity/auth'
import { withDatabaseRequest } from '@/lib/database/database-context'

/** Public UI state only. Each API still performs its own authorization. */
export const initialAuthState = withDatabaseRequest(async () => {
  const identity = await albumCaller()
  return {
    authenticated: true,
    username: identity.username,
    displayName: await accountDisplayName(identity.username),
    role: identity.role,
    canManagePersonal: canManagePersonal(identity),
    mainAdmin: identity.mainAdmin,
    canManageAccess: await hasAccessManagerRole(),
    loading: false,
  }
})
