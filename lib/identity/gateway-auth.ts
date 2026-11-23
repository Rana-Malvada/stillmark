import { postgresPermissionsEnabled } from '../permission-authority'
import { appPermissionIdentity, type AppPermissionIdentity } from '../app-permissions'
import { gatewayRoleCacheMaxEntries } from '../snowflake/snowflake-capacity'
import { uploadTraceCount, uploadTraceGauge } from '../upload/upload-request-trace'
import { cache } from 'react'
import { recordPerformance } from '../observability/performance-metrics'
import { databaseContext } from '../database/database-context'
import { deployment } from '../../config/deployment.mjs'
import { getSecret, SecretType } from '../snowflake'
import { gatewayUserMetadata, refreshGatewayUserMetadata } from './gateway-user-metadata'
import { gatewayRoleMetadata } from './gateway-role-metadata'
import { pgAuthGateway } from '../postgres'
import { HttpError } from '../http'
import { verifyGatewayAssertion } from './gateway-assertion'
import type { CallerIdentity } from './auth'
import { flagOn } from '../flags'

export const GATEWAY_USER = deployment.GATEWAY_USER
type GatewayIdentity = CallerIdentity & { canManageAccess: boolean }
const roleCache = new Map<string, { identity: GatewayIdentity; expires: number }>()
const roleCacheLimit = gatewayRoleCacheMaxEntries()
const pendingRoles = new Map<string, Promise<GatewayIdentity>>()
const field = (row: Record<string, unknown>, key: string) => row[key] ?? row[key.toUpperCase()]
const identifier = (name: string) => {
  if (!/^[A-Z][A-Z0-9_]{1,99}$/.test(name)) throw new HttpError(403, 'Invalid gallery account')
  return `"${name}"`
}
/** Resolve current Snowflake grants with SHOW commands, without waking a warehouse. */
async function resolveRoles(
  username: string,
  marker?: string,
  fresh = true,
  cacheKey?: string,
): Promise<GatewayIdentity & { expires: number }> {
  identifier(username)
  const snapshot = await gatewayUserMetadata(username, fresh ? undefined : cacheKey)
  const { users, direct } = snapshot
  let expires = snapshot.expires
  const user = users.find((row) => field(row, 'name') === username)
  if (!user || ![false, 'false'].includes(field(user, 'disabled') as boolean | string))
    throw new HttpError(403, 'Gallery account is disabled')
  if (marker && field(user, 'comment') !== `Personal Photos managed access ${marker}`)
    throw new HttpError(403, 'Gallery account was changed outside this app')
  const roles = new Set<string>()
  // SHOW GRANTS also returns direct database/schema privileges with a null role.
  const queue = direct
    .filter((row) => field(row, 'granted_on') === 'ROLE' && field(row, 'privilege') === 'USAGE')
    .map((row) => String(field(row, 'role') ?? field(row, 'name')))
    .filter((role) => role !== 'PUBLIC')
  while (queue.length) {
    const batch: string[] = []
    while (queue.length && batch.length < 4) {
      const role = queue.shift()!
      if (roles.has(role)) continue
      if (roles.size >= 64) throw new HttpError(403, 'Unable to resolve gallery access')
      roles.add(role)
      batch.push(role)
    }
    const results = await Promise.all(batch.map((name) => gatewayRoleMetadata(name, fresh)))
    for (const result of results) {
      expires = Math.min(expires, result.expires)
      for (const row of result.rows)
        if (field(row, 'granted_on') === 'ROLE' && field(row, 'privilege') === 'USAGE')
          queue.push(String(field(row, 'name')))
    }
  }
  const appOwner = roles.has(deployment.RESOURCE_PERSONAL_PHOTOS_APP_OWNER)
  const admin = appOwner || roles.has(deployment.RESOURCE_PERSONAL_PHOTOS_ADMIN)
  const readonly = roles.has(deployment.RESOURCE_PERSONAL_PHOTOS_ADMIN_READONLY)
  const viewer = roles.has(deployment.RESOURCE_PERSONAL_PHOTOS_VIEWER)
  if (!admin && !readonly && !viewer) throw new HttpError(403, 'No gallery role assigned')
  if (expires <= Date.now()) throw new HttpError(503, 'Gallery authorization refresh timed out')
  return {
    username,
    expires,
    role: admin ? 'admin' : readonly ? 'admin_readonly' : 'viewer',
    appOwner,
    canManagePersonal: admin || viewer,
    canManageAccess: appOwner || roles.has(deployment.RESOURCE_PERSONAL_PHOTOS_ACCESS_MANAGER),
  }
}

export async function resolveGatewayRoles(
  username: string,
  marker?: string,
  fresh = true,
  cacheKey?: string,
): Promise<GatewayIdentity & { expires: number }> {
  const start = performance.now()
  let failed = true
  try {
    const result = await resolveRoles(username, marker, fresh, cacheKey)
    failed = false
    return result
  } finally {
    recordPerformance('gateway-roles', performance.now() - start, 0, failed)
  }
}

/** Next reserializes query strings before route handlers (for example commas to %2C).
 * Preserve the path, parameter order and duplicates; normalize encoding only. */
export function canonicalGatewayTarget(target: string | null | undefined): string | null {
  if (!target?.startsWith('/') || target.startsWith('//') || target.includes('#')) return null
  const split = target.indexOf('?')
  if (split < 0) return target
  const query = new URLSearchParams(target.slice(split + 1)).toString()
  return target.slice(0, split) + (query ? '?' + query : '')
}

export function gatewayAssertion(h: Pick<Headers, 'get'>) {
  const token = h.get('x-photo-gateway-identity')
  const transportUser = h.get('sf-context-current-user')
  if (!token && transportUser !== GATEWAY_USER) return null
  if (!flagOn('GATEWAY_AUTH_ENABLED') || transportUser !== GATEWAY_USER || !token)
    throw new HttpError(401, 'Gateway authentication required', undefined, 'GATEWAY_AUTH_FAILED')
  const audience = process.env.GATEWAY_ORIGIN
  if (!audience) throw new HttpError(503, 'Gateway is not configured')
  const assertion = verifyGatewayAssertion(
    token,
    getSecret('GATEWAY_SIGNING', SecretType.GENERIC_STRING),
    audience,
  )
  const ctx = databaseContext.getStore()
  const binding = ctx?.kind === 'request' ? ctx.requestBinding : undefined
  const signedTarget = canonicalGatewayTarget(assertion.target)
  if (
    !signedTarget ||
    assertion.method !== (binding?.method ?? h.get('x-photo-request-method')) ||
    signedTarget !== canonicalGatewayTarget(binding?.target ?? h.get('x-photo-request-target'))
  )
    throw new HttpError(401, 'Gateway request binding mismatch', undefined, 'GATEWAY_AUTH_FAILED')
  return assertion
}
// React scopes this cache to a server render; route handlers use AsyncLocalStorage.
const renderBootstrap = cache(pgAuthGateway)

export async function gatewaySession(h: Pick<Headers, 'get'>) {
  const assertion = gatewayAssertion(h)
  if (!assertion) return null
  const ctx = databaseContext.getStore()
  const bootstrap = () =>
    assertion.startedAt === undefined
      ? renderBootstrap(assertion.sub, assertion.sid, assertion.jti, assertion.exp)
      : renderBootstrap(
          assertion.sub,
          assertion.sid,
          assertion.jti,
          assertion.exp,
          assertion.startedAt,
        )
  const object = await (ctx?.kind === 'request'
    ? (ctx.gatewayBootstrap ??= bootstrap())
    : bootstrap())
  if (!object)
    throw new HttpError(
      401,
      'Gateway identity expired, replayed or unlinked',
      undefined,
      'GATEWAY_AUTH_FAILED',
    )
  return { assertion, object }
}

export async function gatewayIdentity(
  h: Pick<Headers, 'get'>,
  fresh = false,
): Promise<GatewayIdentity | null> {
  const session = await gatewaySession(h)
  if (!session) return null
  const { assertion, object } = session
  if (postgresPermissionsEnabled()) return appPermissionIdentity(object as AppPermissionIdentity)
  if (object.revoked)
    throw new HttpError(
      401,
      'Session has been logged out. Please sign in again.',
      undefined,
      'SESSION_REQUIRED',
    )
  // The registry is checked on every request. Coalesce role metadata reads across
  // thumbnail requests; Snowflake disable/revoke changes propagate within 15s.
  // Identity administration bypasses this cache entirely.
  if (fresh) return resolveGatewayRoles(object.name, object.marker)
  const key = `${assertion.sub}:${object.name}:${object.marker}:${object.epoch}`
  const cached = roleCache.get(key)
  uploadTraceGauge('gateway-role-cache-size', roleCache.size)
  if (cached && cached.expires > Date.now()) {
    uploadTraceCount('gateway-role-cache-hit')
    refreshGatewayUserMetadata(object.name, key)
    roleCache.delete(key)
    roleCache.set(key, cached)
    return cached.identity
  }
  if (cached) roleCache.delete(key)
  uploadTraceCount(cached ? 'gateway-role-cache-expired' : 'gateway-role-cache-miss')
  let pending = pendingRoles.get(key)
  if (!pending) {
    pending = resolveGatewayRoles(object.name, object.marker, false, key).then((identity) => {
      roleCache.delete(key)
      while (roleCache.size >= roleCacheLimit) {
        roleCache.delete(roleCache.keys().next().value!)
        uploadTraceCount('gateway-role-cache-evicted')
      }
      roleCache.set(key, { identity, expires: identity.expires })
      return identity
    })
    pendingRoles.set(key, pending)
  }
  uploadTraceGauge('gateway-role-pending', pendingRoles.size)
  try {
    return await pending
  } finally {
    pendingRoles.delete(key)
  }
}
