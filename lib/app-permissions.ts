import type { CallerIdentity } from './identity/auth'
import { deployment } from '../config/deployment.mjs'
import { HttpError } from './http'

export type AppPermissionIdentity = {
  name: string
  marker: string
  revoked: boolean
  epoch: string
  enabled: boolean
  app_role: string | null
  app_owner: boolean
  can_manage_personal: boolean
  can_manage_access: boolean
  main_admin: boolean
}
export function appPermissionIdentity(
  row: AppPermissionIdentity | undefined,
): CallerIdentity & { canManageAccess: boolean } {
  if (!row || row.revoked)
    throw new HttpError(401, 'Session is unavailable or revoked', undefined, 'SESSION_REQUIRED')
  if (row.enabled !== true || !['viewer', 'admin', 'admin_readonly'].includes(row.app_role ?? ''))
    throw new HttpError(403, 'No active gallery access')
  return {
    username: row.name,
    role: row.app_role as CallerIdentity['role'],
    appOwner: row.app_owner === true,
    canManagePersonal: row.can_manage_personal === true,
    canManageAccess: row.can_manage_access === true,
    mainAdmin: row.main_admin === true,
  }
}
export const CUSTOMER_ROLES = {
  member: 'STILLMARK_MEMBER',
  administrator: 'STILLMARK_ADMIN',
} as const
const roles: Record<string, string> = {
  ...CUSTOMER_ROLES,
  viewer: deployment.RESOURCE_PERSONAL_PHOTOS_VIEWER,
  admin: deployment.RESOURCE_PERSONAL_PHOTOS_ADMIN,
  admin_readonly: deployment.RESOURCE_PERSONAL_PHOTOS_ADMIN_READONLY,
  app_owner: deployment.RESOURCE_PERSONAL_PHOTOS_APP_OWNER,
  access_manager: deployment.RESOURCE_PERSONAL_PHOTOS_ACCESS_MANAGER,
}
export function appRoleKey(name: string) {
  const base = Object.entries(roles).find(([, value]) => value === name)?.[0]
  if (base) return base
  if (
    name.startsWith(deployment.RESOURCE_PERSONAL_PHOTOS_GROUP_) &&
    /^[A-Z][A-Z0-9_]{1,99}$/.test(name)
  )
    return 'group:' + name
  throw new HttpError(400, 'Unknown gallery role')
}
export function appRoleName(key: string) {
  if (roles[key]) return roles[key]
  if (key.startsWith('group:')) return key.slice(6)
  throw new Error('Unknown stored gallery role')
}
