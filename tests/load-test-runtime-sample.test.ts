import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})
it('does not start runtime sampling for a production database', async () => {
  vi.useFakeTimers()
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('PG_DATABASE', 'postgres')
  const { startLoadTestRuntimeSampling } = await import('@/lib/load-test-runtime-sample')
  startLoadTestRuntimeSampling()
  expect(vi.getTimerCount()).toBe(0)
})
it('starts only one isolated sampler and logs only numeric aggregate fields', async () => {
  vi.useFakeTimers()
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('PG_DATABASE', 'stillmark_loadtest_unit')
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const { startLoadTestRuntimeSampling } = await import('@/lib/load-test-runtime-sample')
  startLoadTestRuntimeSampling()
  startLoadTestRuntimeSampling()
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(10000)
  const line = write.mock.calls
    .map((c) => String(c[0]))
    .find((s) => s.startsWith('[load-test-runtime] '))!
  const data = JSON.parse(line.slice('[load-test-runtime] '.length))
  expect(Object.keys(data)).toEqual([
    'at',
    'pid',
    'resources',
    'elapsedMs',
    'cpuCores',
    'eventLoopUtilization',
    'eventLoopDelayP99Ms',
    'eventLoopDelayMaxMs',
    'rssBytes',
  ])
  const { resources, ...metrics } = data
  expect(Object.keys(resources).sort()).toEqual(['cpu', 'memoryMiB'])
  expect(
    Object.values({ ...metrics, ...resources }).every(
      (n) => typeof n === 'number' && Number.isFinite(n),
    ),
  ).toBe(true)
})
