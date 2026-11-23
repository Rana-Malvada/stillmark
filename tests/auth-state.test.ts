import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ caller: vi.fn(), access: vi.fn() }))
vi.mock('@/lib/albums/album-access', () => ({
  albumCaller: mocks.caller,
  canManagePersonal: (c: { canManagePersonal?: boolean; role: string }) =>
    c.canManagePersonal ?? c.role !== 'admin_readonly',
}))
vi.mock('@/lib/identity/auth', () => ({ hasAccessManagerRole: mocks.access }))
vi.mock('@/lib/identity/account-display-name', () => ({
  accountDisplayName: async () => 'Reader Name',
}))
import { initialAuthState } from '@/lib/identity/auth-state'

describe('server-provided UI identity', () => {
  it('serializes only UI permissions, preserving read-only restrictions', async () => {
    mocks.caller.mockResolvedValue({
      username: 'reader',
      displayName: 'Reader Name',
      role: 'admin_readonly',
      mainAdmin: false,
      canManagePersonal: false,
      secret: 'never serialize',
    })
    mocks.access.mockResolvedValue(false)
    expect(await initialAuthState()).toEqual({
      authenticated: true,
      username: 'reader',
      displayName: 'Reader Name',
      role: 'admin_readonly',
      mainAdmin: false,
      canManagePersonal: false,
      canManageAccess: false,
      loading: false,
    })
  })
  it('does not render an authenticated page when identity validation fails', async () => {
    mocks.caller.mockRejectedValue(new Error('revoked'))
    await expect(initialAuthState()).rejects.toThrow('revoked')
  })
})
