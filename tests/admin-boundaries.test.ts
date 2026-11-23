import { beforeEach, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({
  query: vi.fn(),
  refresh: vi.fn(),
  operation: vi.fn(),
  sync: vi.fn(),
}))
vi.mock('@/lib/postgres', () => ({ pgAuthEpoch: async () => '1' }))
vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers({
      'sf-context-current-user': 'READONLY',
      'sf-context-current-user-token': 'readonly-boundaries',
      origin: 'https://gallery.example',
      host: 'gallery.example',
    }),
}))
vi.mock('@/lib/snowflake', () => ({ getServiceToken: () => 'runtime', querySnowflake: s.query }))
vi.mock('@/lib/costs/cost-report', () => ({ refreshCostReport: s.refresh }))
vi.mock('@/lib/access-management', () => ({
  accessOverview: vi.fn(),
  accessRequest: vi.fn(),
  operationId: vi.fn(),
  runAccessOperation: s.operation,
}))
vi.mock('@/lib/identity/identity-logs', () => ({ identityStatus: vi.fn(), syncIdentity: s.sync }))
vi.mock('@/lib/observability/activity-action', () => ({ trackAction: vi.fn() }))
import { POST as costs } from '@/app/api/costs/route'
import { POST as access } from '@/app/api/admin/access/route'
import { POST as identity } from '@/app/api/user-activity/identity/route'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('APP_ORIGIN', 'https://gallery.example')
  s.query.mockResolvedValue([
    {
      IS_ADMIN_READONLY: true,
      IS_ADMIN: false,
      IS_APP_OWNER: false,
      IS_VIEWER: true,
      CAN_MANAGE_ACCESS: false,
    },
  ])
})
it('real authorization guards deny readonly administrative writes before side effects', async () => {
  const req = () =>
    new Request('https://gallery.example/api/admin/access', {
      method: 'POST',
      body: JSON.stringify({ provider: 'auth0', action: 'deleteUser', username: 'BOB' }),
    })
  expect((await costs()).status).toBe(403)
  expect((await access(req())).status).toBe(403)
  expect((await identity(req())).status).toBe(403)
  expect(s.refresh).not.toHaveBeenCalled()
  expect(s.operation).not.toHaveBeenCalled()
  expect(s.sync).not.toHaveBeenCalled()
})

it('includes native access-manager membership in cached ordinary reads but checks it freshly for privileged work', async () => {
  const { getCallerIdentity, hasAccessManagerRole } = await import('@/lib/identity/auth')
  const { withDatabaseRequest } = await import('@/lib/database/database-context')
  // Force a distinct cache epoch for this test by resetting the module cache's time.
  vi.spyOn(Date, 'now').mockReturnValueOnce(Date.now() + 120000)
  const caller = await withDatabaseRequest(() => getCallerIdentity())()
  expect(caller.canManageAccess).toBe(false)
  s.query.mockClear()
  await withDatabaseRequest(() => getCallerIdentity())()
  expect(s.query).not.toHaveBeenCalled()
  s.query.mockResolvedValue([{ CAN_MANAGE_ACCESS: false }])
  expect(await withDatabaseRequest(() => hasAccessManagerRole())()).toBe(false)
  expect(s.query).toHaveBeenCalledWith(expect.stringContaining('AS CAN_MANAGE_ACCESS'), {
    callersRights: true,
  })
  vi.restoreAllMocks()
})
