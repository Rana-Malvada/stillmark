import { postgresPermissionsEnabled } from '../permission-authority'
import { appRoleName, CUSTOMER_ROLES } from '../app-permissions'
import { HttpError } from '../http'
import { pgQuery, pgQueryOne } from '../postgres'
import { auth0Enabled } from '../identity/auth0-management'
import { BASE_ROLES, type Managed } from './contracts'
import { safeUser } from './authority'
import { flagOn } from '../flags'

export async function accessOverview() {
  const objects = await pgQuery<Managed>(
    'SELECT * FROM gallery_access_objects ORDER BY created_at DESC',
  )
  const pgPermissions = postgresPermissionsEnabled()
    ? new Map(
        (
          await pgQuery<{ marker: string; enabled: boolean; roles: string[] }>(
            'SELECT * FROM photo_security.app_access_overview()',
          )
        ).map((p) => [p.marker, p]),
      )
    : null
  const users = []
  for (const object of objects.filter((o) => o.kind === 'user')) {
    if (pgPermissions && object.state === 'ready' && !object.deleting) {
      const permission = pgPermissions.get(object.marker)
      users.push({
        ...object,
        roles: (permission?.roles ?? []).map(appRoleName),
        enabled: permission?.enabled === true,
        issue: permission ? null : 'App permission migration is incomplete; access is denied.',
      })
      continue
    }
    if (object.state === 'pending' && !object.deleting) {
      const recovery = await pgQueryOne(
        'SELECT id,actor,request,state,error FROM gallery_access_operations WHERE id=$1',
        [object.marker],
      )
      try {
        const { roles } = await safeUser(object.name, true)
        users.push({
          ...object,
          roles,
          issue:
            'Account setup is unfinished. Resume setup to finish creating the login, or delete this unfinished account.',
          canDelete: true,
          recovery,
        })
      } catch (error) {
        users.push({
          ...object,
          roles: [],
          issue: error instanceof HttpError ? error.message : 'Unable to verify unfinished account',
          canDelete: false,
          recovery: null,
        })
      }
      continue
    }
    try {
      const { roles } = await safeUser(object.name)
      users.push({ ...object, roles, issue: null })
    } catch (error) {
      users.push({
        ...object,
        roles: [],
        issue: object.deleting
          ? 'Deletion unfinished. Retry the delete operation in Audit history.'
          : error instanceof HttpError
            ? error.message
            : 'Unable to read current Snowflake access',
      })
    }
  }
  const operations = await pgQuery(
    'SELECT id,actor,request,state,error,created_at,updated_at FROM gallery_access_operations ORDER BY created_at DESC LIMIT 100',
  )
  return {
    customerAccountsEnabled: flagOn('CUSTOMER_ACCOUNTS_ENABLED') && postgresPermissionsEnabled(),
    auth0Enabled: auth0Enabled(),
    permissionAuthority: postgresPermissionsEnabled() ? 'postgres' : 'snowflake',
    users,
    roles:
      postgresPermissionsEnabled() && flagOn('CUSTOMER_ACCOUNTS_ENABLED')
        ? [
            {
              name: CUSTOMER_ROLES.member,
              display_name: 'Member',
              profile: 'viewer',
              state: 'ready',
            },
            {
              name: CUSTOMER_ROLES.administrator,
              display_name: 'Admin',
              profile: 'app_owner',
              state: 'ready',
            },
          ]
        : [
            {
              name: BASE_ROLES.app_owner,
              display_name: 'App Owner',
              profile: 'app_owner',
              state: 'ready',
            },
            {
              name: BASE_ROLES.viewer,
              display_name: 'Gallery viewers',
              profile: 'viewer',
              state: 'ready',
            },
            {
              name: BASE_ROLES.admin,
              display_name: 'Gallery admins',
              profile: 'admin',
              state: 'ready',
            },
            {
              name: BASE_ROLES.admin_readonly,
              display_name: 'Read-only admins',
              profile: 'admin_readonly',
              state: 'ready',
            },
            ...objects.filter((o) => o.kind === 'role'),
          ],
    operations,
    refreshedAt: new Date().toISOString(),
  }
}
