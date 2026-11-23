import { objects } from '../../config/deployment.mjs'
import { querySnowflake } from '../snowflake'
import { HttpError } from '../http'

type Action =
  | 'findUser'
  | 'findRole'
  | 'userGrants'
  | 'roleGrants'
  | 'createUser'
  | 'createRole'
  | 'restrictUser'
  | 'disableUser'
  | 'deleteUser'
  | 'setPassword'
  | 'setupLink'
  | 'grantRole'
  | 'revokeRole'
  | 'setDefaultRole'
/** Only named operations cross the privilege boundary; the owner procedure validates again. */
export async function identityControl(
  action: Action,
  payload: Record<string, unknown>,
): Promise<Record<string, any>[]> {
  // Metadata SHOW commands require no warehouse. MONITOR USER is read-only;
  // all mutations remain behind the independently validated owner procedure.
  if (['findUser', 'findRole', 'userGrants', 'roleGrants'].includes(action)) {
    const name = payload.name
    if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{1,99}$/.test(name))
      throw new HttpError(403, 'Invalid gallery account')
    const queries = {
      findUser: `SHOW USERS LIKE '${name}'`,
      findRole: `SHOW ROLES LIKE '${name}'`,
      userGrants: `SHOW GRANTS TO USER "${name}"`,
      roleGrants: `SHOW GRANTS TO ROLE "${name}"`,
    }
    const rows = await querySnowflake(queries[action as keyof typeof queries])
    if (action === 'findUser' || action === 'findRole')
      return rows
        .filter((r) => (r.name ?? r.NAME) === name)
        .map((r) => ({
          name: r.name ?? r.NAME,
          comment: r.comment ?? r.COMMENT,
          disabled: r.disabled ?? r.DISABLED,
        }))
    return rows
  }
  const rows = await querySnowflake(`CALL ${objects.identityControl}(?, ?)`, {
    binds: [action, JSON.stringify(payload)],
  })
  const value = rows[0]?.GALLERY_IDENTITY_CONTROL
  const result = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(result)) throw new Error('Invalid identity-control response')
  return result
}
