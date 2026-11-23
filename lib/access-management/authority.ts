// These guards preserve the selected authority and verify ownership before writes.
// Legacy Snowflake management remains supported when PostgreSQL authority is off.
import { postgresPermissionsEnabled } from '../permission-authority'
import { appRoleName, CUSTOMER_ROLES } from '../app-permissions'
import { HttpError } from '../http'
import { pgQuery, pgQueryOne } from '../postgres'
import { identityControl } from '../identity/identity-control'
import { BASE_ROLES, type Managed, markerFor } from './contracts'

export const field = (row: Record<string, any>, key: string) => row[key] ?? row[key.toUpperCase()]
export async function findObject(kind: Managed['kind'], name: string) {
  const rows = await identityControl(kind === 'user' ? 'findUser' : 'findRole', { name })
  return rows.find((row) => field(row, 'name') === name)
}
async function managed(
  kind: Managed['kind'],
  name: string,
  allowPending = false,
): Promise<Managed> {
  const row = await pgQueryOne<Managed>(
    'SELECT * FROM gallery_access_objects WHERE kind=$1 AND name=$2',
    [kind, name],
  )
  if (!row || (!allowPending && (row.state !== 'ready' || row.deleting)))
    throw new HttpError(409, 'This account or role is not ready or is not managed by this app')
  if (postgresPermissionsEnabled()) return row
  const live = await findObject(kind, name)
  if (!live || field(live, 'comment') !== markerFor(row.marker))
    throw new HttpError(
      409,
      'Snowflake object is missing or was changed outside this app; ask the account administrator to review it',
    )
  return row
}
export async function userGrants(name: string) {
  return identityControl('userGrants', { name })
}
export async function safeUser(name: string, allowPending = false) {
  const row = await managed('user', name, allowPending)
  if (postgresPermissionsEnabled()) {
    const grants = await pgQuery<{ role_key: string }>(
      'SELECT * FROM photo_security.app_member_roles($1::uuid)',
      [row.marker],
    )
    return { row, roles: grants.map((g) => appRoleName(g.role_key)) }
  }
  const allGrants = await userGrants(name)
  // Snowflake also returns direct personal-database grants with role=null.
  // Permit only the built-in database/schema grants for this exact user;
  // unrelated direct privileges must still block destructive management.
  const personalDatabase = `USER$${name}`
  const grants = allGrants.filter((grant) => {
    const kind = field(grant, 'granted_on')
    const privilege = field(grant, 'privilege')
    const object = field(grant, 'name')
    if (kind === 'ROLE' && privilege === 'USAGE') return true
    const personal =
      field(grant, 'role') == null &&
      field(grant, 'granted_to') === 'USER' &&
      field(grant, 'grantee_name') === name &&
      ((kind === 'DATABASE' &&
        object === personalDatabase &&
        ['USAGE', 'CREATE SCHEMA'].includes(privilege)) ||
        (kind === 'SCHEMA' &&
          [`${personalDatabase}.LOCAL`, `${personalDatabase}.PUBLIC`].includes(object) &&
          privilege === 'OWNERSHIP'))
    if (!personal)
      throw new HttpError(
        409,
        'This user has non-gallery privileges. Manage this account in Snowflake instead',
      )
    return false
  })
  const known = await pgQuery<{ name: string }>(
    "SELECT name FROM gallery_access_objects WHERE kind='role' AND state='ready'",
  )
  const allowed = new Set<string>([
    'PUBLIC',
    ...Object.values(BASE_ROLES),
    ...known.map((r) => r.name),
  ])
  if (grants.some((r) => !allowed.has(String(field(r, 'role')))))
    throw new HttpError(
      409,
      'This user has non-gallery roles. Manage this account in Snowflake instead',
    )
  for (const grant of grants) {
    const role = String(field(grant, 'role'))
    if (role !== 'PUBLIC') await safeRole(role)
  }
  return { row, roles: grants.map((r) => String(field(r, 'role'))).filter((r) => r !== 'PUBLIC') }
}
export async function safeRole(name: string) {
  if (postgresPermissionsEnabled() && (Object.values(CUSTOMER_ROLES) as string[]).includes(name))
    return
  if ((Object.values(BASE_ROLES) as string[]).includes(name)) return
  const role = await managed('role', name)
  if (postgresPermissionsEnabled()) {
    if (!role.profile || !['viewer', 'admin', 'admin_readonly'].includes(role.profile))
      throw new HttpError(409, 'Invalid gallery role')
    return
  }
  const grants = await identityControl('roleGrants', { name })
  // Only the selected gallery base role may be inherited. Refuse externally expanded roles.
  if (
    !role.profile ||
    grants.some(
      (r) =>
        field(r, 'granted_on') !== 'ROLE' ||
        field(r, 'privilege') !== 'USAGE' ||
        field(r, 'name') !== BASE_ROLES[role.profile!],
    )
  )
    throw new HttpError(
      409,
      'This role has permissions outside its gallery profile; review it in Snowflake',
    )
}
