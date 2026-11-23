import { expect, it } from 'vitest'
import { isPersonalCostData } from '@/lib/costs/personal-cost-response'

const report = {
  selected: 'all',
  selectedLabel: 'All users',
  timeZone: 'America/New_York',
  periodEnd: '2026-11-21',
  canFilter: false,
  canRefresh: true,
  asOf: null,
  trackingStarted: null,
  users: [],
  errors: [],
  userLabels: {},
  subtotalUsd: null,
  prices: { creditUsd: 2 },
  storage: { bytes: 0, files: '0', monthlyUsd: 0 },
  transfers: { uploadedBytes: 0, requestedDownloadBytes: 0 },
  services: [{ key: 'gpu', label: 'Video', method: 'Estimate', credits: null, usd: null }],
  daily: [{ day: '2026-11-21', usd: null }],
  staleSources: [],
}
it('preserves unavailable costs and Postgres bigint counts', () => {
  expect(isPersonalCostData(report)).toBe(true)
  expect(isPersonalCostData({ ...report, storage: { ...report.storage, files: 7 } })).toBe(true)
})
it('rejects malformed arrays, money, labels and records before rendering', () => {
  for (const value of [
    null,
    {},
    { ...report, services: [{}] },
    { ...report, services: null },
    { ...report, userLabels: [] },
    { ...report, daily: [null] },
    { ...report, daily: [{ day: '2026-11-21', usd: {} }] },
    { ...report, subtotalUsd: '10' },
    { ...report, storage: null },
  ])
    expect(isPersonalCostData(value)).toBe(false)
})
