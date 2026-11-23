import { describe, expect, it } from 'vitest'
import { productionCostEstimates, type ProductionCostPeriod } from '@/lib/production-cost-estimates'
import { membershipShare, sumCredits } from '@/lib/costs/personal-costs'

const period: ProductionCostPeriod = {
  key: 'runtime',
  resource: 'production-app',
  from: '2026-01-01T00:00:00Z',
  until: null,
  creditsPerHour: 1,
  units: 1,
}
const rows = (asOf: string, periods = [period]) =>
  productionCostEstimates(asOf, 'America/New_York', periods)[0].rows

describe('production-only resource estimates', () => {
  it('clips today to the report snapshot instead of charging a full future day', () => {
    expect(rows('2026-10-31T16:00:00Z').at(-1)).toEqual({ DAY: '2026-10-31', CREDITS: 12 })
    expect(rows('2026-10-31T16:00:00Z')).toHaveLength(30)
  })
  it('uses actual Eastern day lengths across both DST changes', () => {
    expect(rows('2026-11-02T05:00:00Z').find((r) => r.DAY === '2026-11-01')?.CREDITS).toBe(25)
    expect(rows('2026-03-09T04:00:00Z').find((r) => r.DAY === '2026-03-08')?.CREDITS).toBe(23)
  })
  it('handles a suspension and a rate/size change without rewriting earlier periods', () => {
    const periods = [
      { ...period, until: '2026-10-31T10:00:00Z' },
      { ...period, from: '2026-10-31T10:00:00Z', until: '2026-10-31T12:00:00Z', units: 0 },
      { ...period, from: '2026-10-31T12:00:00Z', creditsPerHour: 2, units: 2 },
    ]
    expect(rows('2026-10-31T16:00:00Z', periods).at(-1)?.CREDITS).toBe(22)
  })
  it('never treats missing or overlapping evidence as a zero-cost resource', () => {
    expect(rows('2026-10-31T16:00:00Z', []).at(-1)?.CREDITS).toBeNull()
    expect(productionCostEstimates(undefined)[0].error).toBeTruthy()
    expect(
      productionCostEstimates('2026-10-31T16:00:00Z', 'UTC', [period, period])[0].error,
    ).toBeTruthy()
    expect(sumCredits(productionCostEstimates('2026-10-31T16:00:00Z', 'UTC', [])[0])).toBeNull()
  })
  it('reconciles member shares and charges nothing before signup or after deletion', () => {
    const members = [
      { username: 'old', joined_at: '2026-01-01T00:00:00Z' },
      { username: 'new', joined_at: '2026-10-31T10:00:00Z' },
      {
        username: 'deleted',
        joined_at: '2026-01-01T00:00:00Z',
        deleted_at: '2026-10-30T00:00:00Z',
      },
    ]
    const asOf = '2026-10-31T16:00:00Z'
    const shares = members.map((m) =>
      membershipShare(members, m.username, '2026-10-31', 'America/New_York', asOf),
    )
    expect(shares).toEqual([2 / 3, 1 / 3, 0])
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1)
    expect(membershipShare(members, 'new', '2026-10-30', 'America/New_York', asOf)).toBe(0)
  })
})
