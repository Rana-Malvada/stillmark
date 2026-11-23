import { postgresPermissionsEnabled } from '../permission-authority'
import { nativeRoleCacheMaxEntries } from '../snowflake/snowflake-capacity'
import { readSharedRole, writeSharedRole } from './shared-role-cache'
import {
  observeUploadAuthKey,
  uploadTraceCount,
  uploadTraceGauge,
} from '../upload/upload-request-trace'
import { ConnectionWaitTimeoutError } from '../connection-deadline'
import { SnowflakeQueryTimeoutError } from '../snowflake/snowflake-query-deadline'
import { pgAuthEpoch } from '../postgres'
import { deployment } from '../../config/deployment.mjs'
import { databaseContext } from '../database/database-context'
import { headers } from 'next/headers'
import { createHash } from 'node:crypto'
import { getServiceToken, querySnowflake } from '@/lib/snowflake'
import { HttpError } from '@/lib/http'

export interface CallerIdentity {
  username: string
  role: 'admin' | 'admin_readonly' | 'viewer'
  canManagePersonal?: boolean
  appOwner?: boolean
  mainAdmin?: boolean
  canManageAccess?: boolean
}
const roleCache = new Map<
  string,
  {
    role: CallerIdentity['role']
    canManagePersonal: boolean
    appOwner: boolean
    canManageAccess: boolean
    expires: number
  }
>()
const inFlight = new Map<
  string,
  Promise<Pick<CallerIdentity, 'role' | 'canManagePersonal' | 'appOwner' | 'canManageAccess'>>
>()
const TTL = 60_000
const roleCacheLimit = nativeRoleCacheMaxEntries()
function rememberRole(key: string, value: NonNullable<ReturnType<typeof roleCache.get>>) {
  roleCache.delete(key)
  while (roleCache.size >= roleCacheLimit) {
    roleCache.delete(roleCache.keys().next().value!)
    uploadTraceCount('role-cache-evicted')
  }
  roleCache.set(key, value)
}

async function requireAuthUncached(): Promise<CallerIdentity> {
  const h = await headers()
  if (
    process.env.NODE_ENV === 'development' &&
    process.env.DEV_AUTH === 'true' &&
    !getServiceToken()
  ) {
    return {
      username: process.env.DEV_USER || 'DEV_ADMIN',
      role: process.env.DEV_ROLE === 'admin_readonly' ? 'admin_readonly' : 'admin',
    }
  }
  const username = h.get('sf-context-current-user')
  if (!getServiceToken() || !username || !h.get('sf-context-current-user-token'))
    throw new HttpError(401, 'Authentication required', undefined, 'SESSION_REQUIRED')
  if (h.get('x-photo-gateway-identity') || username === deployment.GATEWAY_USER) {
    const { gatewayIdentity } = await import('./gateway-auth')
    const identity = await gatewayIdentity(h)
    if (!identity)
      throw new HttpError(401, 'Gateway authentication required', undefined, 'GATEWAY_AUTH_FAILED')
    return identity
  }
  if (postgresPermissionsEnabled())
    throw new HttpError(
      401,
      'Use the application sign-in gateway',
      undefined,
      'GATEWAY_AUTH_FAILED',
    )
  // The platform authenticates the caller. Ordinary reads need no SQL role query.
  return { username, role: 'viewer' }
}
async function getCallerIdentityUncached(fresh = false): Promise<CallerIdentity> {
  const caller = await requireAuth()
  if ((await headers()).get('x-photo-gateway-identity')) {
    if (!fresh) return caller
    const { gatewayIdentity } = await import('./gateway-auth')
    return (await gatewayIdentity(await headers(), true))!
  }
  if (postgresPermissionsEnabled()) return caller
  if (caller.role !== 'viewer') return caller
  const h = await headers()
  const epoch = await pgAuthEpoch(caller.username)
  const key = createHash('sha256')
    .update(
      `${epoch}\0${caller.username}\0${h.get('sf-context-current-role')}\0${h.get('sf-context-current-user-token')}`,
    )
    .digest('hex')
  observeUploadAuthKey(
    () =>
      createHash('sha256')
        .update(`${epoch}\0${caller.username}\0${h.get('sf-context-current-role')}`)
        .digest('hex'),
    key,
  )
  uploadTraceGauge('role-cache-size', roleCache.size)
  const cached = roleCache.get(key)
  uploadTraceCount(
    fresh
      ? 'role-fresh-check'
      : cached && cached.expires > Date.now()
        ? 'role-cache-hit'
        : cached
          ? 'role-cache-expired'
          : 'role-cache-miss',
  )
  if (cached && cached.expires <= Date.now()) roleCache.delete(key)
  if (!fresh && cached && cached.expires > Date.now()) {
    // Touch recency without extending grant expiry or changing the exact-token key.
    roleCache.delete(key)
    roleCache.set(key, cached)
    return {
      ...caller,
      role: cached.role,
      canManagePersonal: cached.canManagePersonal,
      appOwner: cached.appOwner,
      canManageAccess: cached.canManageAccess,
    }
  }
  let pending = fresh ? undefined : inFlight.get(key)
  if (pending) uploadTraceCount('role-query-coalesced')
  if (!pending) {
    uploadTraceCount('role-query-start')
    pending = (async () => {
      if (!fresh) {
        const shared = await readSharedRole(key)
        if (shared) {
          rememberRole(key, shared) // Preserve original expiry; reads never extend grants.
          return shared
        }
      }
      const rows = await querySnowflake(
        `SELECT
           IS_ROLE_IN_SESSION('${deployment.RESOURCE_PERSONAL_PHOTOS_APP_OWNER}') AS IS_APP_OWNER,
           IS_ROLE_IN_SESSION('${deployment.RESOURCE_PERSONAL_PHOTOS_ADMIN}') AS IS_ADMIN,
           IS_ROLE_IN_SESSION('${deployment.RESOURCE_PERSONAL_PHOTOS_ADMIN_READONLY}') AS IS_ADMIN_READONLY,
           IS_ROLE_IN_SESSION('${deployment.RESOURCE_PERSONAL_PHOTOS_VIEWER}') AS IS_VIEWER,
           IS_ROLE_IN_SESSION('${deployment.RESOURCE_PERSONAL_PHOTOS_ACCESS_MANAGER}') AS CAN_MANAGE_ACCESS`,
        { callersRights: true, connectionWaitMs: 5000, connectionProfile: 'role-check' },
      )
      const appOwner = rows[0]?.IS_APP_OWNER === true || rows[0]?.IS_APP_OWNER === 'true'
      const role: CallerIdentity['role'] =
        appOwner || rows[0]?.IS_ADMIN === true || rows[0]?.IS_ADMIN === 'true'
          ? 'admin'
          : rows[0]?.IS_ADMIN_READONLY === true || rows[0]?.IS_ADMIN_READONLY === 'true'
            ? 'admin_readonly'
            : 'viewer'
      const canManagePersonal =
        role !== 'admin_readonly' || rows[0]?.IS_VIEWER === true || rows[0]?.IS_VIEWER === 'true'
      const canManageAccess =
        rows[0]?.CAN_MANAGE_ACCESS === true || rows[0]?.CAN_MANAGE_ACCESS === 'true'
      const verified = {
        role,
        canManagePersonal,
        appOwner,
        canManageAccess,
        expires: Date.now() + TTL,
      }
      rememberRole(key, verified)
      await writeSharedRole(key, verified)
      return { role, canManagePersonal, appOwner, canManageAccess }
    })()
    inFlight.set(key, pending)
  }
  try {
    return { ...caller, ...(await pending) }
  } catch (error) {
    if (error instanceof ConnectionWaitTimeoutError || error instanceof SnowflakeQueryTimeoutError)
      throw new HttpError(503, 'Authentication is temporarily busy. Please retry.', 1)
    throw error
  } finally {
    if (inFlight.get(key) === pending) inFlight.delete(key)
  }
}
export async function requireAdmin(): Promise<CallerIdentity> {
  const ctx = databaseContext.getStore()
  const check = () => getCallerIdentityUncached(true)
  const caller = await (ctx?.kind === 'request' ? (ctx.freshCaller ??= check()) : check())
  if (ctx?.kind === 'request') {
    ctx.caller = Promise.resolve(caller)
    ctx.identity = undefined
  }
  if (caller.role !== 'admin') throw new HttpError(403, 'Administrator access required')
  return caller
}
export async function requireSameOrigin(): Promise<void> {
  const h = await headers()
  const origin = h.get('origin')
  if (!origin || h.get('sec-fetch-site') === 'cross-site')
    throw new HttpError(403, 'Same-origin request required')
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new HttpError(403, 'Invalid origin')
  }
  // Set APP_ORIGIN when the ingress rewrites Host; never trust a client-provided forwarded host.
  const isGateway = h.get('sf-context-current-user') === deployment.GATEWAY_USER
  if (isGateway) await requireAuth()
  const expected = isGateway ? process.env.GATEWAY_ORIGIN : process.env.APP_ORIGIN
  if (expected ? parsed.origin !== expected : parsed.host !== h.get('host'))
    throw new HttpError(403, 'Same-origin request required')
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:')
    throw new HttpError(403, 'HTTPS required')
}

/** Access management never trusts the cached photo-admin flag. */
export async function hasAccessManagerRole(): Promise<boolean> {
  await requireAuth()
  const h = await headers()
  if (h.get('x-photo-gateway-identity')) {
    const { gatewayIdentity } = await import('./gateway-auth')
    const identity = await gatewayIdentity(h, true)
    const ctx = databaseContext.getStore()
    if (identity && ctx?.kind === 'request') {
      ctx.auth = ctx.caller = Promise.resolve(identity)
      ctx.identity = undefined
    }
    return identity?.canManageAccess === true
  }
  if (
    process.env.NODE_ENV === 'development' &&
    process.env.DEV_AUTH === 'true' &&
    !getServiceToken()
  ) {
    return process.env.DEV_ACCESS_MANAGER === 'true'
  }
  if (postgresPermissionsEnabled()) return (await requireAuth()).canManageAccess === true
  const rows = await querySnowflake(
    `SELECT IS_ROLE_IN_SESSION('${deployment.RESOURCE_PERSONAL_PHOTOS_ACCESS_MANAGER}') AS CAN_MANAGE_ACCESS`,
    { callersRights: true },
  )
  const allowed = rows[0]?.CAN_MANAGE_ACCESS === true || rows[0]?.CAN_MANAGE_ACCESS === 'true'
  const ctx = databaseContext.getStore()
  if (ctx?.kind === 'request') {
    const caller = await getCallerIdentity()
    ctx.caller = Promise.resolve({ ...caller, canManageAccess: allowed })
    ctx.identity = undefined
  }
  return allowed
}
export async function requireAccessManager(): Promise<CallerIdentity> {
  const caller = await requireAuth()
  if (!(await hasAccessManagerRole()))
    throw new HttpError(403, 'Access Manager permission required')
  return caller
}

/** Read-only administrative surfaces; mutation guards remain requireAdmin/requireAccessManager. */
export async function requireAdminRead(): Promise<CallerIdentity> {
  const caller = await getCallerIdentity()
  if (caller.role === 'viewer') throw new HttpError(403, 'Administrative visibility required')
  return caller
}
export async function requireAccessRead(): Promise<CallerIdentity> {
  const caller = await getCallerIdentity()
  if (caller.role === 'admin_readonly') return caller
  return requireAccessManager()
}

/** Coalesce authentication only within this request, never across users or requests. */
export function requireAuth(): Promise<CallerIdentity> {
  const ctx = databaseContext.getStore()
  return ctx?.kind === 'request' ? (ctx.auth ??= requireAuthUncached()) : requireAuthUncached()
}
export function getCallerIdentity(): Promise<CallerIdentity> {
  const ctx = databaseContext.getStore()
  return ctx?.kind === 'request'
    ? (ctx.caller ??= getCallerIdentityUncached())
    : getCallerIdentityUncached()
}
