import { headers } from 'next/headers'
import { type AlbumCaller, albumCaller } from '../albums/album-access'
import { appPermissionIdentity } from '../app-permissions'
import { databaseContext, type DatabaseIdentity } from '../database/database-context'
import { HttpError } from '../http'
import { postgresPermissionsEnabled } from '../permission-authority'
import { pgAuthMainAdmin, pgSessionAuthority } from '../postgres'
import type { CallerIdentity } from './auth'

/** Runs `fn` as the caller of this request, with authority read from the database now. */
export type AsCurrentCaller = <T>(fn: (caller: AlbumCaller) => Promise<T>) => Promise<T>

const signedOut = () =>
  new HttpError(401, 'Session is unavailable or revoked', undefined, 'SESSION_REQUIRED')

/**
 * For a response that outlives the check it started with (a ZIP of many originals).
 *
 * A request is authenticated once: its gateway assertion is short-lived and single-use,
 * and the identity it resolved is cached for the request. This returns a function that,
 * each time it is called, reads from the database what that same session may do now:
 * the account still linked and enabled, the session not logged out, not older than the
 * credential cutoff, and its current role. The assertion is not consumed again. Only its
 * already verified subject, session and start time are kept.
 *
 * The refreshed identity replaces the request's cached one, so the queries inside `fn`
 * run under row-level security as what the caller is now, not what it was. It throws 401
 * (logged out, unlinked) or 403 (disabled, no role); the caller must stop the response.
 *
 * Call it once, while the request is being handled, after authentication. A deployment
 * without the sign-in gateway has no application session to revoke: there the platform
 * authenticates each request and the request's own identity is used. With permissions
 * held in PostgreSQL (the supported production configuration) that path is unreachable,
 * because a request without the gateway is refused. The branch for gateway sign-in with
 * roles held in Snowflake resolves roles afresh for every file and has no test of its own.
 */
export async function sessionAuthorityRefresher(): Promise<AsCurrentCaller> {
  const requestHeaders = await headers()
  const context = databaseContext.getStore()
  if (!requestHeaders.get('x-photo-gateway-identity') || context?.kind !== 'request') {
    const caller = await albumCaller()
    return (fn) => fn(caller)
  }
  // Loaded only for gateway requests, as in auth.ts.
  const { gatewayAssertion, resolveGatewayRoles } = await import('./gateway-auth')
  const assertion = gatewayAssertion(requestHeaders)
  if (!assertion) throw signedOut()
  const { username } = await albumCaller()
  const { sub, sid, startedAt } = assertion

  const refresh = async (): Promise<AlbumCaller> => {
    const row = await pgSessionAuthority(sub, sid, startedAt)
    // The session belongs to one account; a different one under the same subject is not it.
    if (!row || row.name !== username) throw signedOut()
    let identity: CallerIdentity & { canManageAccess: boolean }
    let mainAdmin: boolean
    if (postgresPermissionsEnabled()) {
      identity = appPermissionIdentity(row)
      mainAdmin = identity.mainAdmin === true
    } else {
      if (row.revoked) throw signedOut()
      identity = await resolveGatewayRoles(row.name, row.marker)
      context.nativeMainAdmin = undefined
      mainAdmin = await pgAuthMainAdmin(row.name)
    }
    // The same derivation as `getDatabaseIdentity`, from the refreshed row.
    const database: DatabaseIdentity = {
      username: identity.username,
      mainAdmin: (identity.appOwner === true || mainAdmin) && identity.role !== 'admin_readonly',
      adminRead: identity.role !== 'viewer',
      adminWrite: identity.role === 'admin',
      canWrite: identity.canManagePersonal ?? identity.role !== 'admin_readonly',
      accessManager: identity.canManageAccess,
    }
    context.auth = context.caller = Promise.resolve(identity)
    context.freshCaller = undefined
    context.identity = Promise.resolve(database)
    return { ...identity, mainAdmin: database.mainAdmin }
  }
  // The archive is produced after the handler has returned; keep its database work in
  // this request's scope whatever asynchronous context the stream is pulled from.
  return (fn) => databaseContext.run(context, async () => fn(await refresh()))
}
