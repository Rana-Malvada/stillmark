import { beforeEach, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({
  read: vi.fn(),
  manage: vi.fn(),
  origin: vi.fn(),
  status: vi.fn(),
  sync: vi.fn(),
}))
vi.mock('@/lib/identity/auth', () => ({
  requireAdminRead: vi.fn(),
  requireAccessRead: s.read,
  requireAccessManager: s.manage,
  requireSameOrigin: s.origin,
}))
vi.mock('@/lib/identity/identity-logs', () => ({ identityStatus: s.status, syncIdentity: s.sync }))
vi.mock('@/lib/observability/activity-action', () => ({ trackAction: vi.fn() }))
import { GET, POST } from '@/app/api/user-activity/identity/route'
import { HttpError } from '@/lib/http'

beforeEach(() => {
  vi.resetAllMocks()
  s.status.mockResolvedValue([])
  s.sync.mockResolvedValue({ imported: 1 })
})
const request = (provider = 'auth0') =>
  new Request('https://app/api/user-activity/identity', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  })
it('read-only viewing only retrieves saved status', async () => {
  expect((await GET()).status).toBe(200)
  expect(s.status).toHaveBeenCalled()
  expect(s.sync).not.toHaveBeenCalled()
})
it('blocks read-only imports before provider access', async () => {
  s.manage.mockRejectedValue(new HttpError(403, 'Denied'))
  expect((await POST(request())).status).toBe(403)
  expect(s.sync).not.toHaveBeenCalled()
})
it('requires same origin and a valid provider', async () => {
  s.origin.mockRejectedValueOnce(new HttpError(403, 'Denied'))
  expect((await POST(request())).status).toBe(403)
  expect((await POST(request('other'))).status).toBe(400)
  expect(s.sync).not.toHaveBeenCalled()
})
it('only imports the requested provider', async () => {
  expect((await POST(request('auth0'))).status).toBe(200)
  expect(s.sync).toHaveBeenCalledExactlyOnceWith('auth0')
})
