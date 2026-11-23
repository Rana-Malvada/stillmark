import { afterEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ query: vi.fn(), epoch: vi.fn() }))
vi.mock('@/lib/upload/upload-queue-database', () => ({
  uploadQueuePool: () => ({ query: m.query }),
}))
vi.mock('@/lib/postgres', () => ({ pgAuthEpoch: m.epoch }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetAllMocks()
  vi.resetModules()
})
it('does not query dispatcher credentials when the feature is off', async () => {
  vi.stubEnv('UPLOAD_PROCESSING_QUEUE_ENABLED', 'false')
  const { GET } = await import('@/app/api/health/upload-ready/route')
  expect((await GET()).status).toBe(200)
  expect(m.query).not.toHaveBeenCalled()
})
it('fails readiness if queue infrastructure is unavailable', async () => {
  vi.stubEnv('UPLOAD_PROCESSING_QUEUE_ENABLED', 'true')
  m.query.mockRejectedValue(Error('missing credential'))
  m.epoch.mockResolvedValue('1')
  const { GET } = await import('@/app/api/health/upload-ready/route')
  expect((await GET()).status).toBe(503)
})
it('checks both credentials and caches successful checks briefly', async () => {
  vi.stubEnv('UPLOAD_PROCESSING_QUEUE_ENABLED', 'true')
  m.query.mockResolvedValue({ rows: [{ route: 'pool' }] })
  m.epoch.mockResolvedValue('1')
  const { GET } = await import('@/app/api/health/upload-ready/route')
  expect((await GET()).status).toBe(200)
  expect((await GET()).status).toBe(200)
  expect(m.query).toHaveBeenCalledTimes(2)
  expect(m.epoch).toHaveBeenCalledOnce()
})
