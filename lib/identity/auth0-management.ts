import { getSecret, SecretType } from '../snowflake'
import { HttpError } from '../http'
import { flagOn } from '../flags'

// Server-only caller: access-management. Never expose Management API credentials to the browser.
export const auth0Enabled = () => flagOn('AUTH0_MANAGEMENT_ENABLED')
type Identity = {
  name: string
  marker: string
  email: string | null
  display_name: string
  auth0_user_id?: string | null
  registration_source?: string
}
type Auth0User = {
  user_id: string
  app_metadata?: Record<string, unknown>
  identities?: { provider: string; connection: string }[]
}
let cached: { key: string; token: string; expires: number } | undefined
const connection = () => process.env.AUTH0_DATABASE_CONNECTION || 'Username-Password-Authentication'
function config() {
  const domain = process.env.AUTH0_DOMAIN || ''
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.auth0\.com$/.test(domain))
    throw new HttpError(503, 'Auth0 management is not configured')
  try {
    const secret = getSecret('AUTH0_MANAGEMENT', SecretType.PASSWORD)
    return { domain, ...secret }
  } catch {
    throw new HttpError(503, 'Auth0 management credentials are not configured')
  }
}
async function request(url: string, init: RequestInit) {
  try {
    return await fetch(url, {
      ...init,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    throw new HttpError(
      502,
      'Auth0 could not be reached. Retry the same operation; completed steps are retained.',
    )
  }
}
async function token() {
  const c = config()
  const key = c.domain + ':' + c.username
  if (cached?.key === key && cached.expires > Date.now() + 60000)
    return { domain: c.domain, token: cached.token }
  const r = await request(`https://${c.domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: c.username,
      client_secret: c.password,
      audience: `https://${c.domain}/api/v2/`,
    }),
  })
  if (!r.ok)
    throw new HttpError(
      503,
      'Auth0 management authorization failed. Check the application credentials and API permissions.',
    )
  const b = await r.json()
  if (typeof b.access_token !== 'string' || typeof b.expires_in !== 'number')
    throw new HttpError(502, 'Auth0 returned an invalid authorization response')
  cached = { key, token: b.access_token, expires: Date.now() + b.expires_in * 1000 }
  return { domain: c.domain, token: b.access_token as string }
}
async function api(path: string, method = 'GET', body?: unknown, allow404 = false) {
  const t = await token()
  const r = await request(`https://${t.domain}/api/v2/${path}`, {
    method,
    headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (r.status === 401) cached = undefined
  if (allow404 && r.status === 404) return null
  // Never return/log upstream bodies: password validation responses can echo submitted data.
  if (!r.ok) {
    if (r.status === 409)
      throw new HttpError(
        409,
        'An Auth0 account already uses this username or email. Existing accounts are never automatically replaced or linked.',
      )
    if (r.status === 400) {
      const detail = await r.json().catch(() => null)
      // Classify known errors; never echo upstream text, which can include credentials.
      if (
        detail?.name === 'PasswordStrengthError' ||
        (typeof detail?.message === 'string' && detail.message.startsWith('PasswordStrengthError:'))
      )
        throw new HttpError(
          400,
          'Auth0 rejected this password as too weak. Choose a stronger password with uppercase, lowercase, numbers and symbols, then resume setup or retry the password change.',
        )
      throw new HttpError(
        400,
        'Auth0 rejected the account details or password. Check the username limits and password policy in Auth0.',
      )
    }
    if (r.status === 429)
      throw new HttpError(
        429,
        'Auth0 is rate limiting requests. Wait briefly, then retry the same operation.',
      )
    throw new HttpError(
      502,
      'Auth0 could not finish the operation. Check Management API permissions and retry the same operation.',
    )
  }
  return r.status === 204 ? null : r.json()
}
const userPath = (id: string) => `users/${encodeURIComponent(id)}`
export function verifyAuth0User(user: Auth0User, object: Identity) {
  if (
    (object.registration_source === 'public'
      ? !object.auth0_user_id || user.user_id !== object.auth0_user_id
      : user.app_metadata?.gallery_marker !== object.marker ||
        user.app_metadata?.snowflake_login !== object.name) ||
    user.identities?.length !== 1 ||
    user.identities[0].provider !== 'auth0' ||
    user.identities[0].connection !== connection()
  )
    throw new HttpError(
      409,
      'Auth0 ownership or login mapping changed. An administrator must review this account before it can be modified.',
    )
}
export async function inspectAuth0User(object: Identity) {
  const id = object.auth0_user_id || `auth0|${object.marker}`
  const user = (await api(userPath(id), 'GET', undefined, true)) as Auth0User | null
  if (user) verifyAuth0User(user, object)
  return user
}
export async function ensureAuth0User(object: Identity, password: string) {
  const existing = await inspectAuth0User(object)
  if (existing) return existing.user_id
  if (object.auth0_user_id)
    throw new HttpError(
      409,
      'The linked Auth0 user is missing. Ask an administrator to review the account.',
    )
  if (!object.email) throw new HttpError(400, 'An email is required for an Auth0 account')
  const created = (await api('users', 'POST', {
    user_id: object.marker,
    connection: connection(),
    username: object.name.toLowerCase(),
    email: object.email.toLowerCase(),
    name: object.display_name,
    password,
    verify_email: false,
    email_verified: false,
    app_metadata: { gallery_marker: object.marker, snowflake_login: object.name },
  })) as Auth0User
  verifyAuth0User(created, object)
  return created.user_id
}
export async function setAuth0Password(object: Identity, password: string) {
  const user = await inspectAuth0User(object)
  if (!user) throw new HttpError(409, 'The linked Auth0 user is missing')
  await api(userPath(user.user_id), 'PATCH', { password, connection: connection() })
}
export async function deleteAuth0User(object: Identity) {
  const user = await inspectAuth0User(object)
  if (user) await api(userPath(user.user_id), 'DELETE', undefined, true)
}

/** Checkpoint log retrieval is tenant-wide upstream; callers must filter client_id before storage. */
export async function readAuth0LogPage(
  from?: string,
): Promise<{ logs: Record<string, unknown>[]; cursor: string | null }> {
  if (!auth0Enabled()) throw new HttpError(503, 'Auth0 management is disabled')
  if (from && !/^\d{1,100}$/.test(from)) throw new HttpError(400, 'Invalid Auth0 checkpoint')
  const t = await token()
  const query = from ? `from=${from}&take=100` : 'sort=log_id%3A1&per_page=1'
  const r = await request(`https://${t.domain}/api/v2/logs?${query}`, {
    headers: { Authorization: `Bearer ${t.token}` },
  })
  if (r.status === 401) cached = undefined
  if (r.status === 403) {
    cached = undefined
    throw new HttpError(403, 'Auth0 requires read:logs permission on the management application')
  }
  if (r.status === 429) throw new HttpError(429, 'Auth0 log import is rate limited; retry later')
  if (!r.ok) throw new HttpError(502, 'Auth0 log import failed; saved checkpoint retained')
  const logs = await r.json()
  if (
    !Array.isArray(logs) ||
    logs.length > 100 ||
    logs.some((l) => !l || typeof l.log_id !== 'string' || !/^\d{1,100}$/.test(l.log_id))
  )
    throw new HttpError(502, 'Invalid Auth0 log response')
  // Follow the documented next checkpoint without accepting an arbitrary upstream URL.
  const link = r.headers.get('link')?.match(/<([^>]+)>;\s*rel="?next"?/)
  let cursor = logs.at(-1)?.log_id ?? from ?? null
  if (link) {
    const next = new URL(link[1])
    const point = next.searchParams.get('from')
    if (
      next.origin !== `https://${t.domain}` ||
      next.pathname !== '/api/v2/logs' ||
      !point ||
      !/^\d{1,100}$/.test(point)
    )
      throw new HttpError(502, 'Invalid Auth0 log checkpoint')
    cursor = point
  }
  return { logs, cursor }
}
