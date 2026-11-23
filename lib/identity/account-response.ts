export type Account = {
  displayName: string
  email?: string | null
  publicAccount: boolean
  uploadLimit?: number
  uploadsUsed?: number
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
export function isAccount(value: unknown): value is Account {
  if (
    !record(value) ||
    typeof value.displayName !== 'string' ||
    typeof value.publicAccount !== 'boolean'
  )
    return false
  if (value.email != null && typeof value.email !== 'string') return false
  return (
    !value.publicAccount ||
    (Number.isSafeInteger(value.uploadLimit) &&
      Number(value.uploadLimit) >= 0 &&
      Number.isSafeInteger(value.uploadsUsed) &&
      Number(value.uploadsUsed) >= 0)
  )
}
export function isAccountSaved(value: unknown): value is { ok: true } {
  return record(value) && value.ok === true
}
export type AuthResponse = {
  authenticated: boolean
  username: string | null
  displayName?: string | null
  role: 'admin' | 'admin_readonly' | 'viewer' | null
  canManagePersonal: boolean
  mainAdmin: boolean
  canManageAccess: boolean
}
export function isAuthResponse(value: unknown): value is AuthResponse {
  if (!record(value) || typeof value.authenticated !== 'boolean') return false
  if (!value.authenticated) return value.username == null && value.role == null
  return (
    typeof value.username === 'string' &&
    value.username.length > 0 &&
    (value.displayName == null || typeof value.displayName === 'string') &&
    typeof value.role === 'string' &&
    ['admin', 'admin_readonly', 'viewer'].includes(value.role) &&
    ['canManagePersonal', 'mainAdmin', 'canManageAccess'].every(
      (key) => typeof value[key] === 'boolean',
    )
  )
}
export function isLogoutDestination(value: unknown): value is { url: string } {
  if (!record(value) || typeof value.url !== 'string') return false
  try {
    const url = new URL(value.url)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}
