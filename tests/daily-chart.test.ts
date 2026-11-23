import { expect, it } from 'vitest'
import { costMetrics, dailyData } from '@/lib/costs/daily-chart'

it('uses 30 UTC calendar days and aggregates daily model credits without inventing missing usage', () => {
  const { metrics, group } = costMetrics.ai
  const result = dailyData(
    [
      { DAY: '2026-09-15', MODEL_NAME: 'model A', CREDITS: '0.1' },
      { DAY: '2026-09-15', MODEL_NAME: 'model A', CREDITS: '0.2' },
      { DAY: '2026-09-15', MODEL_NAME: 'model B', CREDITS: 0 },
      { DAY: '2026-08-01', MODEL_NAME: 'older', CREDITS: 20 },
      { DAY: '2026-09-14', MODEL_NAME: 'model A', CREDITS: null },
    ],
    metrics,
    '2026-09-15T23:00:00Z',
    30,
    group,
  )
  expect(result.days).toHaveLength(30)
  expect(result.days[0]).toBe('2026-08-17')
  expect(result.days.at(-1)).toBe('2026-09-15')
  expect(result.series.map((s) => s.name)).toEqual(['model A', 'model B'])
  expect(result.series[0].values.at(-1)).toBeCloseTo(0.3)
  expect(result.series[0].values.at(-2)).toBeNull()
  expect(result.series[1].values.at(-1)).toBe(0)
})
it('keeps warehouse components and sparse storage snapshots separate', () => {
  const result = dailyData(
    [{ DAY: '2026-02-28', COMPUTE_CREDITS: '1.2', CLOUD_SERVICES_CREDITS: '0.03' }],
    costMetrics.warehouse.metrics,
    '2026-03-01',
  )
  expect(result.days.at(-2)).toBe('2026-02-28')
  expect(result.series.map((s) => s.values.at(-2))).toEqual([1.2, 0.03])
  const storage = dailyData(
    [{ day: '2026-09-15', active: 12, trash: 0.1 }],
    [
      { key: 'active', label: 'Active' },
      { key: 'trash', label: 'Trash' },
    ],
    '2026-09-16',
  )
  expect(storage.series[0].values.at(-1)).toBeNull()
  expect(storage.series[0].values.at(-2)).toBe(12)
})
it('ignores malformed values and dates instead of plotting them as zero', () => {
  expect(
    dailyData(
      [
        { DAY: '2026-09-15', CREDITS: 'invalid' },
        { DAY: 'bad', CREDITS: 4 },
      ],
      costMetrics.runtime.metrics,
      '2026-09-15',
    ).series,
  ).toEqual([])
  expect(dailyData([], costMetrics.runtime.metrics, 'bad')).toEqual({ days: [], series: [] })
})

it('fills absent usage days with zero, preserving explicit unavailable days and sums', () => {
  const rows = [
    { DAY: '2026-09-14', SERVICE_NAME: 'photos', CREDITS: 2 },
    { DAY: '2026-09-14', SERVICE_NAME: 'photos', CREDITS: 3 },
    { DAY: '2026-09-15', SERVICE_NAME: 'photos', CREDITS: null },
  ]
  const result = dailyData(rows, costMetrics.search.metrics, '2026-09-16', 4, 'SERVICE_NAME', 0)
  expect(result.series).toEqual([{ name: 'photos', values: [0, 5, null, 0] }])
})
it('shows an all-zero chart for a successful empty usage report', () => {
  for (const config of Object.values(costMetrics)) {
    const result = dailyData([], config.metrics, '2026-09-16', 30, config.group, 0)
    expect(result.series.length).toBeGreaterThan(0)
    expect(
      result.series.every((s) => s.values.length === 30 && s.values.every((v) => v === 0)),
    ).toBe(true)
  }
})
it('never converts invalid or partially unavailable totals to zero', () => {
  const result = dailyData(
    [
      { DAY: '2026-09-15', CREDITS: 2 },
      { DAY: '2026-09-15', CREDITS: 'invalid' },
      { DAY: '2026-09-15', CREDITS: 3 },
    ],
    costMetrics.runtime.metrics,
    '2026-09-16',
    2,
    undefined,
    0,
  )
  expect(result.series[0].values).toEqual([null, 0])
})
