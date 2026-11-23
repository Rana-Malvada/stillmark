import { deployment } from '../../config/deployment.mjs'
import { postgresPermissionsEnabled } from '../permission-authority'
import { HttpError, textValue } from '../http'

export const ACCESS_MANAGER_ROLE = deployment.RESOURCE_PERSONAL_PHOTOS_ACCESS_MANAGER
export const BASE_ROLES = {
  viewer: deployment.RESOURCE_PERSONAL_PHOTOS_VIEWER,
  admin: deployment.RESOURCE_PERSONAL_PHOTOS_ADMIN,
  admin_readonly: deployment.RESOURCE_PERSONAL_PHOTOS_ADMIN_READONLY,
  app_owner: deployment.RESOURCE_PERSONAL_PHOTOS_APP_OWNER,
} as const
const GROUP_PREFIX = deployment.RESOURCE_PERSONAL_PHOTOS_GROUP_
export const markerFor = (marker: string) => `Personal Photos managed access ${marker}`
export type Profile = keyof typeof BASE_ROLES
export type Managed = {
  kind: 'user' | 'role'
  name: string
  marker: string
  profile: Profile | null
  display_name: string
  email: string | null
  created_by: string
  state: 'pending' | 'ready'
  auth0_user_id?: string | null
  registration_source?: string
  deleting?: boolean
}
export type AccessRequest =
  | { action: 'createUser'; name: string; displayName: string; email: string; password?: string }
  | { action: 'setPassword'; name: string; password: string }
  | { action: 'setUserEnabled'; name: string; enabled: boolean }
  | { action: 'createRole'; name: string; displayName: string; profile: Profile }
  | { action: 'grantRole' | 'revokeRole'; name: string; role: string }
  | { action: 'setupLink'; name: string }
  | { action: 'deleteUser'; name: string; marker: string; confirmation: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function operationId(value: unknown) {
  if (typeof value !== 'string' || !uuid.test(value))
    throw new HttpError(400, 'Invalid operation ID')
  return value
}
export function identifier(value: unknown) {
  const raw = textValue(value, 'name', 100)
  // Public account IDs are immutable database identifiers, not Snowflake identifiers.
  if (/^U_[0-9a-f]{32}$/.test(raw)) return raw
  const name = raw.toUpperCase()
  if (!/^[A-Z][A-Z0-9_]{1,99}$/.test(name))
    throw new HttpError(400, 'Use 2–100 letters, numbers or underscores, starting with a letter')
  return name
}
function passwordValue(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length < 14 ||
    value.length > 256 ||
    !/[A-Z]/.test(value) ||
    !/[a-z]/.test(value) ||
    !/[0-9]/.test(value) ||
    /\p{Cc}/u.test(value)
  )
    throw new HttpError(
      400,
      'Use a password of 14–256 characters with uppercase, lowercase and a number',
    )
  return value
}
export function accessRequest(body: Record<string, unknown>): AccessRequest {
  const name = identifier(body.name)
  switch (body.action) {
    case 'createUser': {
      if (
        /^(ACCOUNTADMIN|SECURITYADMIN|SYSADMIN|USERADMIN|PUBLIC|SNOWFLAKE|PERSONAL_PHOTOS_)/.test(
          name,
        )
      )
        throw new HttpError(400, 'This name is reserved')
      const email = textValue(body.email, 'email', 254)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new HttpError(400, 'Enter a valid email address')
      return {
        action: body.action,
        name,
        displayName: textValue(body.displayName, 'display name', 100),
        email,
        ...(body.password === undefined ? {} : { password: passwordValue(body.password) }),
      }
    }
    case 'createRole':
      if (
        typeof body.profile !== 'string' ||
        !['viewer', 'admin', 'admin_readonly'].includes(body.profile)
      )
        throw new HttpError(400, 'Choose Viewer, Admin or Read-only admin')
      if (!name.startsWith(GROUP_PREFIX) || name.length === GROUP_PREFIX.length)
        throw new HttpError(400, `Role names must start with ${GROUP_PREFIX}`)
      return {
        action: body.action,
        name,
        displayName: textValue(body.displayName, 'display name', 100),
        profile: body.profile as Profile,
      }
    case 'grantRole':
    case 'revokeRole':
      return { action: body.action, name, role: identifier(body.role) }
    case 'setUserEnabled':
      if (!postgresPermissionsEnabled() || typeof body.enabled !== 'boolean')
        throw new HttpError(400, 'Invalid account status change')
      return { action: body.action, name, enabled: body.enabled }
    case 'setPassword':
      return { action: body.action, name, password: passwordValue(body.password) }
    case 'deleteUser':
      if (body.confirmation !== name)
        throw new HttpError(400, 'Type the exact username to confirm deletion')
      return { action: body.action, name, marker: operationId(body.marker), confirmation: name }
    case 'setupLink':
      return { action: body.action, name }
    default:
      throw new HttpError(400, 'Unknown access action')
  }
}
