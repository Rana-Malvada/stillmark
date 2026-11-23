import { expect, it } from 'vitest'
import { operationalAlerts } from '@/lib/operational-alerts'

it('reports actionable failures, not manual sync backlog or pending automatic retries', () => {
  expect(
    operationalAlerts({
      sync: null,
      failures: [{ ai_attempts: 1 }],
      cleanup: [],
      uploads: [{ status: 'SUCCESS' }],
    }),
  ).toEqual([])
  expect(
    operationalAlerts({
      sync: { last_error: 'error' },
      failures: [{ ai_attempts: 3 }],
      cleanup: [{}],
      uploads: [{ status: 'FAILED' }],
    }).map((a) => a.code),
  ).toEqual(['search-sync', 'ai-retries', 'cleanup', 'uploads'])
})
