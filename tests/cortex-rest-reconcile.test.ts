import { expect, it, vi } from 'vitest'

vi.mock('../lib/postgres', () => ({ pgIndependent: vi.fn() }))
import { reconcileRestUsage, recordedRestUsage } from '../lib/snowflake/cortex-rest-reconcile'

it('uses actual credits if supplied and otherwise prices Snowflake token counts', () => {
  const row = {
    REQUEST_ID: 'r1',
    MODEL_NAME: 'claude-haiku-4-5',
    TOKENS_GRANULAR: { input: 1000, output: 200 },
  }
  expect(recordedRestUsage(row).CREDITS).toBe(0.001)
  expect(recordedRestUsage({ ...row, USAGE_RECORD: { CREDITS: 0.002 } }).CREDITS).toBe(0.002)
  expect(recordedRestUsage({ ...row, TOKENS_GRANULAR: {} }).CREDITS).toBeNull()
  expect(
    recordedRestUsage({ ...row, TOKENS_GRANULAR: { input: 1000, output: 200, new_token_type: 10 } })
      .CREDITS,
  ).toBeNull()
})
it('reconciles exact request IDs once, preserving owner attribution and pending estimates', () => {
  const local = [
    { REQUEST_ID: 'local1', PROVIDER_REQUEST_ID: 'r1', WORK_ID: 'owner-work', CREDITS: 0.001 },
    { REQUEST_ID: 'local2', PROVIDER_REQUEST_ID: 'r2', WORK_ID: 'other-work', CREDITS: 0.003 },
  ]
  const rows = reconcileRestUsage(local, [
    { REQUEST_ID: 'r1', CREDITS: 0.002, BASIS: 'Snowflake metered credits' },
    { REQUEST_ID: 'unrelated', CREDITS: 40 },
  ])
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ WORK_ID: 'owner-work', CREDITS: 0.002, RECONCILED: true })
  expect(rows[1]).toMatchObject({ CREDITS: 0.003, RECONCILED: false })
})

it('matches Agents against billed Agents credits, not direct REST pricing or unrelated requests', () => {
  const local = [
    {
      REQUEST_ID: 'local',
      PROVIDER_REQUEST_ID: 'r1',
      PRICING_VERSION: 'agents-unverified',
      WORK_ID: 'w1',
      CREDITS: null,
    },
  ]
  const direct = [{ REQUEST_ID: 'r1', CREDITS: 99 }]
  expect(reconcileRestUsage(local, direct)[0].CREDITS).toBeNull()
  const rows = reconcileRestUsage(local, direct, [
    { REQUEST_ID: 'r1', CREDITS: 0.0046, BASIS: 'Snowflake metered Agents credits' },
    { REQUEST_ID: 'unrelated', CREDITS: 50 },
  ])
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ CREDITS: 0.0046, WORK_ID: 'w1', RECONCILED: true })
})
