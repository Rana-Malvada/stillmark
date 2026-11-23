import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), origin: vi.fn(), one: vi.fn(), wake: vi.fn() }))
vi.mock('@/lib/database/database-context', () => ({ withDatabaseRequest: (fn: unknown) => fn }))
vi.mock('@/lib/albums/album-access', () => ({ requireUploadUser: mocks.user }))
vi.mock('@/lib/identity/auth', () => ({ requireSameOrigin: mocks.origin }))
vi.mock('@/lib/postgres', () => ({ pgQueryOne: mocks.one }))
// Keep the real phase read (it runs on the mocked database); only the wake-up is stubbed.
vi.mock('@/lib/upload/upload-routing', async (actual) => ({
  ...(await actual<typeof import('@/lib/upload/upload-routing')>()),
  requestUploadMode: mocks.wake,
}))
import { GET, POST } from '@/app/api/upload/routing/route'
import { HttpError } from '@/lib/http'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.user.mockResolvedValue({ username: 'member' })
  mocks.one.mockResolvedValue({ phase: 'suspended' })
  mocks.wake.mockResolvedValue({ phase: 'resuming' })
})
it('status polls remain read only even when pool is suspended', async () => {
  for (let i = 0; i < 5; i++) expect((await GET()).status).toBe(200)
  expect(mocks.wake).not.toHaveBeenCalled()
  expect(mocks.one.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true)
})
it('authenticated upload intent requests startup with same-origin protection', async () => {
  expect((await POST()).status).toBe(200)
  expect(mocks.origin).toHaveBeenCalled()
  expect(mocks.wake).toHaveBeenCalledWith('pool', 'member')
  mocks.wake.mockClear()
  mocks.origin.mockRejectedValue(new HttpError(403, 'Forbidden'))
  expect((await POST()).status).toBe(403)
  expect(mocks.wake).not.toHaveBeenCalled()
})
