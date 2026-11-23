import { afterEach, expect, it, vi } from 'vitest'

const metric = vi.hoisted(() => vi.fn())
vi.mock('@/lib/observability/performance-metrics', () => ({ recordPerformance: metric }))
import { runActivityWork } from '@/lib/observability/activity-work'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})
it('drops excess analytics without queuing and releases capacity after failures', async () => {
  vi.stubEnv('ACTIVITY_MAX_IN_FLIGHT', '1')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = runActivityWork(() => gate)
  const overflow = vi.fn()
  await runActivityWork(overflow)
  expect(overflow).not.toHaveBeenCalled()
  expect(metric).toHaveBeenCalledWith('activity-dropped', 0, 0, true)
  release()
  await first
  await expect(
    runActivityWork(async () => {
      throw Error('failure')
    }),
  ).resolves.toBeUndefined()
  const next = vi.fn(async () => {})
  await runActivityWork(next)
  expect(next).toHaveBeenCalledOnce()
  expect(metric).toHaveBeenCalledWith('activity-work', expect.any(Number), 0, true)
})
