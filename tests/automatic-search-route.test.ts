import { beforeEach, expect, it, vi } from 'vitest'
import { HttpError } from '@/lib/http'

const s = vi.hoisted(() => ({ admin: vi.fn(), origin: vi.fn(), retry: vi.fn(), start: vi.fn() }))
vi.mock('@/lib/database/database-context', () => ({ withDatabaseRequest: (fn: unknown) => fn }))
vi.mock('@/lib/albums/album-access', () => ({ requireMainAdmin: s.admin }))
vi.mock('@/lib/identity/auth', () => ({ requireSameOrigin: s.origin }))
vi.mock('@/lib/search/automatic-search', () => ({ retryAutomaticSearch: s.retry }))
vi.mock('@/lib/search/search-batch', () => ({
  startSearchBatch: s.start,
  searchBatchStatus: vi.fn(),
  stopSearchBatch: vi.fn(),
  retrySearchFollowup: vi.fn(),
}))
import { POST } from '@/app/api/admin/search-batch/route'

const request = () =>
  new Request('https://app/api/admin/search-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'retry-publishing' }),
  })
beforeEach(() => {
  vi.resetAllMocks()
  s.admin.mockResolvedValue({ username: 'owner' })
  s.retry.mockResolvedValue({ id: 'cycle', queued: true })
})
it('queues a bounded retry without starting OCR or doing remote work inline', async () => {
  const response = await POST(request())
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ id: 'cycle', queued: true })
  expect(s.retry).toHaveBeenCalledOnce()
  expect(s.start).not.toHaveBeenCalled()
  expect(s.origin).toHaveBeenCalledOnce()
})
it.each(['admin', 'origin'] as const)('retains the %s security gate', async (gate) => {
  s[gate].mockRejectedValue(new HttpError(403, 'Denied'))
  expect((await POST(request())).status).toBe(403)
  expect(s.retry).not.toHaveBeenCalled()
  expect(s.start).not.toHaveBeenCalled()
})
it('returns a conflict for unavailable retry rather than falling through to OCR', async () => {
  s.retry.mockRejectedValue(new HttpError(409, 'No interrupted publishing'))
  expect((await POST(request())).status).toBe(409)
  expect(s.start).not.toHaveBeenCalled()
})
