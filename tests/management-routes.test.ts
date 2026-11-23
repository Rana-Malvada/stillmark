vi.mock('@/lib/albums/album-access', () => ({
  albumMutation: async (fn: Function) => {
    const c = await mocks.admin()
    return fn(c)
  },
  requirePhotoAccess: vi.fn(),
  requireTrashAccess: vi.fn(),
  requireUploadUser: mocks.admin,
  requireMainAdmin: mocks.admin,
  albumCaller: mocks.admin,
  accessibleAlbumIds: async () => [1, 2],
}))
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  origin: vi.fn(),
  pg: vi.fn(),
  one: vi.fn(),
  purge: vi.fn(),
  costRead: vi.fn(),
  costRefresh: vi.fn(),
}))
vi.mock('@/lib/identity/auth', () => ({
  requireAdminRead: mocks.admin,
  requireAdmin: mocks.admin,
  requireSameOrigin: mocks.origin,
}))
vi.mock('@/lib/postgres', () => ({ pgQuery: mocks.pg, pgQueryOne: mocks.one }))
vi.mock('@/lib/photos/photo-management', () => ({
  photoIds: (v: number[]) => v,
  restorePhotos: vi.fn(),
  permanentlyDeleteTrash: mocks.purge,
}))
vi.mock('@/lib/costs/cost-report', () => ({
  storedCostReport: mocks.costRead,
  refreshCostReport: mocks.costRefresh,
}))
import { PATCH as date } from '@/app/api/photos/[photoId]/date/route'
import { DELETE as purge } from '@/app/api/trash/route'
import { GET as costRead, POST as costRefresh } from '@/app/api/costs/route'
import { GET as activity, POST as retry } from '@/app/api/activity/route'
import { GET as uploadStatus } from '@/app/api/upload/chunk/route'
import { HttpError } from '@/lib/http'

const ctx = { params: Promise.resolve({ photoId: '12' }) }
const req = (body: object) =>
  new Request('https://app/api/test', { method: 'PATCH', body: JSON.stringify(body) })
beforeEach(() => {
  vi.resetAllMocks()
  mocks.admin.mockResolvedValue({ username: 'alice', mainAdmin: true })
  mocks.pg.mockResolvedValue([{ photo_id: 1 }, { photo_id: 2 }])
})
it('restricts administration endpoints to admins', async () => {
  mocks.admin.mockRejectedValue(new HttpError(403, 'Admin required'))
  for (const response of [
    await date(req({ dateTaken: null }), ctx),
    await purge(req({ all: true, confirm: 'PERMANENTLY_DELETE' })),
    await costRead(new Request('https://app/api/costs')),
    await costRefresh(),
    await activity(),
    await retry(req({ action: 'retry-cleanup' })),
    await uploadStatus(
      new Request('https://app/api/upload/chunk?uploadId=11111111-1111-4111-8111-111111111111'),
    ),
  ])
    expect(response.status).toBe(403)
  expect(mocks.pg).not.toHaveBeenCalled()
  expect(mocks.one).not.toHaveBeenCalled()
  expect(mocks.costRefresh).not.toHaveBeenCalled()
})
it('requires confirmation and same origin for permanent deletion', async () => {
  expect((await purge(req({ all: true }))).status).toBe(400)
  expect(mocks.purge).not.toHaveBeenCalled()
  mocks.purge.mockResolvedValue({ count: 2 })
  expect((await purge(req({ all: true, confirm: 'PERMANENTLY_DELETE' }))).status).toBe(200)
  expect(mocks.purge).toHaveBeenCalledWith([1, 2])
  mocks.origin.mockRejectedValue(new HttpError(403, 'Wrong origin'))
  expect((await purge(req({ all: true, confirm: 'PERMANENTLY_DELETE' }))).status).toBe(403)
})
it('validates date edits and allows clearing without changing the original metadata', async () => {
  for (const dateTaken of ['bad', '2026-01-01T12:00:00', '2026-02-30T12:00:00Z', 123, undefined])
    expect((await date(req({ dateTaken }), ctx)).status).toBe(400)
  mocks.one.mockResolvedValue({ photo_id: 12 })
  expect((await date(req({ dateTaken: '2026-06-01T12:00:00-07:00' }), ctx)).status).toBe(200)
  expect(mocks.one.mock.calls[0][1]).toEqual([12, '2026-06-01T12:00:00-07:00'])
  expect((await date(req({ dateTaken: null }), ctx)).status).toBe(200)
  mocks.origin.mockRejectedValue(new HttpError(403, 'Wrong origin'))
  expect((await date(req({ dateTaken: null }), ctx)).status).toBe(403)
})
it('reads cached costs without triggering refresh and scopes upload recovery to its owner', async () => {
  mocks.costRead.mockResolvedValue({ report: null })
  expect((await costRead(new Request('https://app/api/costs'))).status).toBe(200)
  expect(mocks.costRefresh).not.toHaveBeenCalled()
  vi.stubEnv('UPLOAD_SERVICE_ONLY', 'true')
  vi.stubEnv('UPLOAD_ROUTING_MANAGED', 'false')
  mocks.one.mockResolvedValue(null)
  const response = await uploadStatus(
    new Request('https://app/api/upload/chunk?uploadId=11111111-1111-4111-8111-111111111111'),
  )
  expect(await response.json()).toEqual({ exists: false, chunks: [] })
  expect(mocks.one.mock.calls[0][1]).toEqual(['11111111-1111-4111-8111-111111111111', 'alice'])
})

it('returns only completion metadata after a refresh, not raw account billing rows', async () => {
  mocks.costRefresh.mockResolvedValue({ asOf: 'saved', sections: [{ rows: ['private ledger'] }] })
  const response = await costRefresh()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ asOf: 'saved' })
})
