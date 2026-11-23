import { expect, it } from 'vitest'
import { costChartMetrics, toggleCostType } from '@/lib/costs/cost-chart-selection'
import { dailyData } from '@/lib/costs/daily-chart'

const services = [
  { key: 'photo_ai', label: 'Photo AI' },
  { key: 'video_ai', label: 'Video AI' },
]
it('All plots one server total, including costs outside the chosen AI categories', () => {
  const metrics = costChartMetrics([], services)
  expect(metrics).toEqual([{ key: 'usd', label: 'Total cost' }])
  const result = dailyData(
    [{ day: '2026-10-06', photo_ai: 2, video_ai: 3, usd: 9 }],
    metrics,
    '2026-10-06',
    1,
  )
  expect(result.series).toEqual([{ name: 'Total cost', values: [9] }])
})
it('compares chosen types and returns to total when the last selection is removed', () => {
  let selected = toggleCostType([], 'video_ai')
  selected = toggleCostType(selected, 'photo_ai')
  expect(costChartMetrics(selected, services)).toEqual(services)
  selected = toggleCostType(selected, 'video_ai')
  expect(costChartMetrics(selected, services)).toEqual([services[0]])
  expect(costChartMetrics(toggleCostType(selected, 'photo_ai'), services)[0].key).toBe('usd')
})

it('plots face recognition as a selectable daily series in dollars and raw credits', async () => {
  const { costMetrics } = await import('@/lib/costs/daily-chart')
  const metrics = costChartMetrics(
    ['faces'],
    [...services, { key: 'faces', label: 'Photo face recognition' }],
  )
  expect(
    dailyData([{ day: '2026-10-06', faces: 14, usd: 20 }], metrics, '2026-10-06', 1).series,
  ).toEqual([{ name: 'Photo face recognition', values: [14] }])
  const raw = costMetrics.faces
  expect(
    dailyData(
      [{ DAY: '2026-10-06', CREDITS: 7, COMPUTE_POOL_NAME: 'FACE_CPU' }],
      raw.metrics,
      '2026-10-06',
      1,
      raw.group,
    ).series[0].values,
  ).toEqual([7])
})
