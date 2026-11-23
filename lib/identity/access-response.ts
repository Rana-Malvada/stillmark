import type { AccessRequest } from '../access-management'

export type Role = {
  name: string
  display_name: string
  profile: 'viewer' | 'admin' | 'admin_readonly' | 'app_owner'
  state: string
}
export type User = {
  registration_source?: string
  enabled?: boolean
  canDelete?: boolean
  recovery?: Omit<Operation, 'created_at'> | null
  auth0_user_id?: string | null
  deleting?: boolean
  name: string
  marker: string
  display_name: string
  email: string | null
  state: string
  roles: string[]
  issue: string | null
}
export type Operation = {
  id: string
  actor: string
  request: AccessRequest
  state: string
  error: string | null
  created_at: string
}
export type Overview = {
  customerAccountsEnabled?: boolean
  permissionAuthority?: 'postgres' | 'snowflake'
  auth0Enabled: boolean
  users: User[]
  roles: Role[]
  operations: Operation[]
  refreshedAt: string
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const optionalText = (value: unknown) => value == null || text(value)
const optionalBoolean = (value: unknown) => value === undefined || typeof value === 'boolean'
const profile = (value: unknown) =>
  text(value) && ['viewer', 'admin', 'admin_readonly', 'app_owner'].includes(value)
const strings = (value: unknown) => Array.isArray(value) && value.every(text)

/** Read-only journal validation, not a substitute for accessRequest authorization. */
function journalRequest(value: unknown): value is AccessRequest {
  if (!record(value) || !text(value.name)) return false
  switch (value.action) {
    case 'createUser':
      return text(value.displayName) && text(value.email) && optionalText(value.password)
    case 'createRole':
      return text(value.displayName) && profile(value.profile)
    case 'setPassword':
      return text(value.password)
    case 'setUserEnabled':
      return typeof value.enabled === 'boolean'
    case 'grantRole':
    case 'revokeRole':
      return text(value.role)
    case 'setupLink':
      return true
    case 'deleteUser':
      return text(value.marker) && text(value.confirmation)
    default:
      return false
  }
}
function operation(value: unknown, dated: boolean) {
  return (
    record(value) &&
    text(value.id) &&
    text(value.actor) &&
    text(value.state) &&
    optionalText(value.error) &&
    journalRequest(value.request) &&
    (!dated || text(value.created_at))
  )
}
export function isAccessOverview(value: unknown): value is Overview {
  return (
    record(value) &&
    typeof value.auth0Enabled === 'boolean' &&
    optionalBoolean(value.customerAccountsEnabled) &&
    (value.permissionAuthority === undefined ||
      (text(value.permissionAuthority) &&
        ['postgres', 'snowflake'].includes(value.permissionAuthority))) &&
    text(value.refreshedAt) &&
    Array.isArray(value.users) &&
    value.users.every(
      (user) =>
        record(user) &&
        ['name', 'marker', 'display_name', 'state'].every((key) => text(user[key])) &&
        optionalText(user.email) &&
        optionalText(user.issue) &&
        strings(user.roles) &&
        optionalText(user.registration_source) &&
        optionalText(user.auth0_user_id) &&
        ['enabled', 'canDelete', 'deleting'].every((key) => optionalBoolean(user[key])) &&
        (user.recovery == null || operation(user.recovery, false)),
    ) &&
    Array.isArray(value.roles) &&
    value.roles.every(
      (role) =>
        record(role) &&
        ['name', 'display_name', 'state'].every((key) => text(role[key])) &&
        profile(role.profile),
    ) &&
    Array.isArray(value.operations) &&
    value.operations.every((op) => operation(op, true))
  )
}
export type AccessResult = { message: string; setupUrl?: string }
export function isAccessResult(value: unknown): value is AccessResult {
  if (!record(value) || !text(value.message)) return false
  if (value.setupUrl === undefined) return true
  if (!text(value.setupUrl)) return false
  try {
    const url = new URL(value.setupUrl)
    return (
      url.protocol === 'https:' &&
      url.hostname.endsWith('.snowflakecomputing.com') &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}
