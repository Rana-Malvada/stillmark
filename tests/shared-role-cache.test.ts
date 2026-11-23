import { afterEach, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('../lib/postgres', () => ({ pgReadRoleCache: db.read, pgWriteRoleCache: db.write }))
import {
  readSharedRole,
  signRoleCache,
  verifyRoleCache,
  writeSharedRole,
} from '../lib/identity/shared-role-cache'

const secret = 'a'.repeat(64)
const key = 'b'.repeat(64)
const value = () => ({
  role: 'viewer' as const,
  canManagePersonal: true,
  appOwner: false,
  canManageAccess: false,
  expires: Date.now() + 30_000,
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})
it('accepts authenticated capabilities only for the exact context digest and signing key', () => {
  const role = value()
  const envelope = signRoleCache(key, role, secret)
  expect(verifyRoleCache(key, envelope, secret)).toEqual(role)
  expect(verifyRoleCache('changed-user-token-role-or-epoch', envelope, secret)).toBeUndefined()
  expect(verifyRoleCache(key, envelope, 'rotated-key')).toBeUndefined()
  const tampered = JSON.parse(envelope)
  tampered.payload = tampered.payload.replace('viewer', 'admin')
  expect(verifyRoleCache(key, JSON.stringify(tampered), secret)).toBeUndefined()
})
it('rejects expired, overlong and malformed capabilities even when correctly signed', () => {
  for (const role of [
    { ...value(), expires: Date.now() - 1 },
    { ...value(), expires: Date.now() + 120_000 },
    { ...value(), appOwner: 'true' },
    { ...value(), role: 'owner' },
  ]) {
    expect(verifyRoleCache(key, signRoleCache(key, role as any, secret), secret)).toBeUndefined()
  }
  expect(verifyRoleCache(key, '{}', secret)).toBeUndefined()
})
it('is off by default and cache outages cannot manufacture authorization', async () => {
  vi.stubEnv('NATIVE_ROLE_CACHE_SIGNING_KEY', undefined)
  expect(await readSharedRole(key)).toBeUndefined()
  await writeSharedRole(key, value())
  expect(db.read).not.toHaveBeenCalled()
  expect(db.write).not.toHaveBeenCalled()
  vi.stubEnv('NATIVE_ROLE_CACHE_SIGNING_KEY', secret)
  db.read.mockRejectedValueOnce(new Error('database unavailable'))
  expect(await readSharedRole(key)).toBeUndefined()
})
it('preserves original expiry when another instance reads the result', async () => {
  vi.stubEnv('NATIVE_ROLE_CACHE_SIGNING_KEY', secret)
  const role = value()
  db.read.mockResolvedValue(signRoleCache(key, role, secret))
  expect(await readSharedRole(key)).toEqual(role)
  expect(db.write).not.toHaveBeenCalled()
})
