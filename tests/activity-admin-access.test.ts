import { beforeEach, expect, it, vi } from 'vitest'
import { HttpError } from '@/lib/http'

const mocks = vi.hoisted(() => ({ admin: vi.fn(), access: vi.fn(), links: vi.fn() }))
vi.mock('@/lib/identity/auth', () => ({
  requireAdminRead: mocks.admin,
  requireAccessRead: mocks.access,
  requireAccessManager: mocks.access,
}))
vi.mock('@/lib/albums/public-albums', () => ({ listSharedLinks: mocks.links }))
import { GET as sharedLinks } from '@/app/api/shared-links/route'
import { GET as activity } from '@/app/api/user-activity/route'
import { GET as summary } from '@/app/api/user-activity/summary/route'
import { GET as exportReport } from '@/app/api/user-activity/export/route'
import { GET as identity, POST as syncIdentity } from '@/app/api/user-activity/identity/route'

beforeEach(() => vi.resetAllMocks())
it('denies non-admins even with Access Manager permission before accessing activity data', async () => {
  mocks.admin.mockRejectedValue(new HttpError(403, 'Administrative visibility required'))
  mocks.access.mockResolvedValue({ role: 'viewer', canManageAccess: true })
  for (const get of [sharedLinks, activity, summary, exportReport]) {
    expect((await get(new Request('https://app/api/activity'))).status).toBe(403)
  }
  expect((await identity()).status).toBe(403)
  expect(
    (await syncIdentity(new Request('https://app/api/user-activity/identity', { method: 'POST' })))
      .status,
  ).toBe(403)
  expect(mocks.access).not.toHaveBeenCalled()
  expect(mocks.links).not.toHaveBeenCalled()
})
it.each(['admin', 'admin_readonly'])('allows %s to read shared-link activity', async (role) => {
  mocks.admin.mockResolvedValue({ role })
  mocks.links.mockResolvedValue({ links: [], hasMore: false })
  const response = await sharedLinks(new Request('https://app/api/shared-links'))
  expect(response.status).toBe(200)
  expect(mocks.admin).toHaveBeenCalledOnce()
  expect(mocks.links).toHaveBeenCalledOnce()
})
