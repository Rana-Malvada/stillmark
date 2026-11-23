import { afterEach, expect, it, vi } from 'vitest'
import { probeQueryDeadline } from '@/scripts/load-test/query-deadline-probe'

afterEach(() => vi.unstubAllEnvs())
it('refuses fault injection outside the isolated database', async () => {
  vi.stubEnv('PG_DATABASE', 'postgres')
  await expect(probeQueryDeadline()).rejects.toThrow()
})
it('runs the cloud loopback probe against the real SDK', async () => {
  vi.stubEnv('PG_DATABASE', 'stillmark_loadtest_baseline')
  const result = await probeQueryDeadline()
  expect(result).toMatchObject({ passed: true, recovery: true, logins: 3, logouts: 3, poolSize: 0 })
  expect(result.outcomes).toHaveLength(2)
  expect(result.outcomes.every((x) => x.queryAttempts === 1 && x.elapsedMs < 4000)).toBe(true)
}, 15000)
