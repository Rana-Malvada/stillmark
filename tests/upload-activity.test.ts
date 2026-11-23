import { beforeEach, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({
  jobs: [] as (() => Promise<void>)[],
  auth: vi.fn(),
  session: vi.fn(),
  record: vi.fn(),
}))
vi.mock('next/server', () => ({ after: (fn: () => Promise<void>) => s.jobs.push(fn) }))
vi.mock('@/lib/identity/auth', () => ({ requireAuth: s.auth }))
vi.mock('@/lib/postgres', () => ({ pgQueryOne: s.session }))
vi.mock('@/lib/observability/user-activity', () => ({ recordAction: s.record }))
import { trackUpload } from '@/lib/observability/activity-action'

const id = '11111111-1111-4111-8111-111111111111'
beforeEach(() => {
  vi.clearAllMocks()
  s.jobs = []
  s.auth.mockResolvedValue({ username: 'alice' })
})
it('uses owned stored bytes and result with an idempotency key', async () => {
  s.session.mockResolvedValue({ bytes: '2048', result: { successCount: 0, skippedCount: 1 } })
  trackUpload('completed', id)
  await s.jobs[0]()
  expect(s.session.mock.calls[0][1]).toEqual([id, 'alice'])
  expect(s.record).toHaveBeenCalledWith(
    'alice',
    'upload_completed',
    `upload:${id}`,
    expect.objectContaining({ bytes: 2048, outcome: 'skipped' }),
    id,
  )
})
it('does not record missing or unowned upload sessions and contains tracking failures', async () => {
  s.session.mockResolvedValue(null)
  trackUpload('failed', id, 500)
  await s.jobs[0]()
  expect(s.record).not.toHaveBeenCalled()
  s.session.mockRejectedValue(new Error('database unavailable'))
  trackUpload('started', id)
  await expect(s.jobs[1]()).resolves.toBeUndefined()
})
