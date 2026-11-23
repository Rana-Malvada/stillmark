import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  origin: vi.fn(),
  status: vi.fn(),
  request: vi.fn(),
}))
vi.mock('@/lib/albums/album-access', () => ({ requireMainAdmin: mocks.admin }))
vi.mock('@/lib/identity/auth', () => ({ requireSameOrigin: mocks.origin }))
vi.mock('@/lib/upload/upload-routing', () => ({
  uploadRoutingStatus: mocks.status,
  requestUploadMode: mocks.request,
}))
import { GET, POST } from '@/app/api/admin/upload-routing/route'
import { HttpError } from '@/lib/http'

const req = (mode: unknown) =>
  new Request('https://app/api/admin/upload-routing', {
    method: 'POST',
    body: JSON.stringify({ mode }),
  })
beforeEach(() => {
  vi.stubEnv('UPLOAD_ROUTING_MANAGED', 'true')
  vi.resetAllMocks()
  mocks.admin.mockResolvedValue({ username: 'ADMIN' })
  mocks.status.mockResolvedValue({ route: 'app' })
  mocks.request.mockResolvedValue({ route: 'app', phase: 'resuming' })
})
it('requires main admin before reading or changing global routing', async () => {
  mocks.admin.mockRejectedValue(new HttpError(403, 'Main admin required'))
  expect((await GET()).status).toBe(403)
  expect((await POST(req('app'))).status).toBe(403)
  expect(mocks.status).not.toHaveBeenCalled()
  expect(mocks.request).not.toHaveBeenCalled()
})
it('requires same origin, valid mode and explicit rollout enablement', async () => {
  mocks.origin.mockRejectedValueOnce(new HttpError(403, 'Wrong origin'))
  expect((await POST(req('app'))).status).toBe(403)
  expect((await POST(req('other'))).status).toBe(400)
  vi.stubEnv('UPLOAD_ROUTING_MANAGED', 'false')
  expect((await POST(req('pool'))).status).toBe(409)
  expect(mocks.request).not.toHaveBeenCalled()
})
it('GET is read only; POST persists intent with the admin identity', async () => {
  expect((await GET()).headers.get('Cache-Control')).toBe('no-store')
  expect(mocks.request).not.toHaveBeenCalled()
  expect((await POST(req('pool'))).status).toBe(200)
  expect(mocks.request).toHaveBeenCalledWith('pool', 'ADMIN')
})
