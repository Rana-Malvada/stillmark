import { createHmac, timingSafeEqual } from 'node:crypto'
import { pgReadRoleCache, pgWriteRoleCache } from '../postgres'
import { uploadTraceCount } from '../upload/upload-request-trace'

export type VerifiedRole = {
  role: 'admin' | 'admin_readonly' | 'viewer'
  canManagePersonal: boolean
  appOwner: boolean
  canManageAccess: boolean
  expires: number
}
function secret() {
  const value = process.env.NATIVE_ROLE_CACHE_SIGNING_KEY
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined
}
function signature(key: string, payload: string, signingKey: string) {
  return createHmac('sha256', signingKey).update(`${key}\0${payload}`).digest()
}
/** Bind cached capabilities to the exact token/context digest; never cache credentials. */
export function verifyRoleCache(
  key: string,
  envelope: string,
  signingKey: string,
  now = Date.now(),
): VerifiedRole | undefined {
  try {
    const { payload, mac } = JSON.parse(envelope)
    if (typeof payload !== 'string' || typeof mac !== 'string' || !/^[a-f0-9]{64}$/.test(mac))
      return
    if (!timingSafeEqual(signature(key, payload, signingKey), Buffer.from(mac, 'hex'))) return
    const value = JSON.parse(payload)
    if (
      !['admin', 'admin_readonly', 'viewer'].includes(value.role) ||
      !['canManagePersonal', 'appOwner', 'canManageAccess'].every(
        (k) => typeof value[k] === 'boolean',
      ) ||
      !Number.isSafeInteger(value.expires) ||
      value.expires <= now ||
      value.expires > now + 60_000
    )
      return
    return value
  } catch {
    return
  }
}
export function signRoleCache(key: string, value: VerifiedRole, signingKey: string) {
  const payload = JSON.stringify(value)
  return JSON.stringify({ payload, mac: signature(key, payload, signingKey).toString('hex') })
}
export async function readSharedRole(key: string): Promise<VerifiedRole | undefined> {
  const signingKey = secret()
  if (!signingKey) return
  try {
    const envelope = await pgReadRoleCache(key)
    const value = envelope ? verifyRoleCache(key, envelope, signingKey) : undefined
    uploadTraceCount(value ? 'role-shared-hit' : 'role-shared-miss')
    return value
  } catch {
    uploadTraceCount('role-shared-read-failed')
    // A cache outage still requires the original Snowflake authorization check.
    return
  }
}
export async function writeSharedRole(key: string, value: VerifiedRole) {
  const signingKey = secret()
  if (!signingKey) return
  try {
    await pgWriteRoleCache(key, signRoleCache(key, value, signingKey), value.expires)
  } catch {
    uploadTraceCount('role-shared-write-failed')
  }
}
