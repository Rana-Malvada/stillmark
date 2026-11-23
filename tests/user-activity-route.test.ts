import { beforeEach, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({
  auth: vi.fn(),
  access: vi.fn(),
  origin: vi.fn(),
  report: vi.fn(),
  record: vi.fn(),
  set: vi.fn(),
}))
vi.mock('@/lib/identity/auth', () => ({
  requireAdminRead: vi.fn(),
  requireAuth: s.auth,
  requireAccessRead: s.access,
  requireSameOrigin: s.origin,
}))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: s.set }) }))
vi.mock('@/lib/observability/user-activity', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  recordViews: s.record,
  activityReport: s.report,
}))
import { GET, POST } from '@/app/api/user-activity/route'
import { HttpError } from '@/lib/http'

beforeEach(() => {
  vi.clearAllMocks()
  s.auth.mockResolvedValue({ username: 'actual' })
  s.access.mockResolvedValue({ username: 'manager' })
  s.origin.mockResolvedValue(undefined)
  s.report.mockResolvedValue({})
  s.record.mockResolvedValue('11111111-1111-4111-8111-111111111111')
})
it('denies activity when the administrative read guard rejects access', async () => {
  s.access.mockRejectedValue(new HttpError(403, 'Denied'))
  expect((await GET(new Request('https://app/api/user-activity'))).status).toBe(403)
  expect(s.report).not.toHaveBeenCalled()
})
it('uses server identity and sets a secure production cookie', async () => {
  vi.stubEnv('NODE_ENV', 'production')
  const r = await POST(
    new Request('https://app/api/user-activity', {
      method: 'POST',
      body: JSON.stringify({ events: [], username: 'forged' }),
    }),
  )
  expect(r.status).toBe(200)
  expect(s.record.mock.calls[0][0]).toBe('actual')
  expect(s.set.mock.calls[0][2]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'strict' })
  vi.unstubAllEnvs()
})
it('requires same origin before writing', async () => {
  s.origin.mockRejectedValue(new HttpError(403, 'Denied'))
  expect(
    (
      await POST(
        new Request('https://app/api/user-activity', { method: 'POST', body: '{"events":[]}' }),
      )
    ).status,
  ).toBe(403)
  expect(s.record).not.toHaveBeenCalled()
})

it('allows read-only administrators to view reports without writing events', async () => {
  s.access.mockResolvedValue({ username: 'readonly', role: 'admin_readonly' })
  expect((await GET(new Request('https://app/api/user-activity'))).status).toBe(200)
  expect(s.record).not.toHaveBeenCalled()
})
it('bounds timeline ranges and validates cursors', async () => {
  expect((await GET(new Request('https://app/api/user-activity?days=10000'))).status).toBe(400)
  expect(
    (await GET(new Request('https://app/api/user-activity?before=bad&beforeId=bad'))).status,
  ).toBe(400)
  expect(s.report).not.toHaveBeenCalled()
})
