import config from '../config/production-cost-estimates.json'
import { COST_TIME_ZONE, costDay, costMidnight } from './costs/cost-timezone'
import type { CostSection } from './costs/personal-costs'

export interface ProductionCostPeriod {
  key: string
  resource: string
  from: string
  until: string | null
  creditsPerHour: number
  units: number
}
/** Configuration-backed production estimates. Never consumes account-wide billing totals.
 * Periods must cover a day completely; missing coverage is unavailable, not free.
 * Record suspension as a zero-unit period and resizing as a new rate period.
 */
export function productionCostEstimates(
  asOf: string | undefined,
  timeZone = COST_TIME_ZONE,
  periods: ProductionCostPeriod[] = config.periods,
): CostSection[] {
  const cutoff = Date.parse(asOf ?? '')
  return ['runtime', 'postgres'].map((key) => {
    const result: CostSection = {
      key,
      label: key === 'runtime' ? 'App hosting — estimated' : 'PostgreSQL compute — estimated',
      rows: [],
      error: null,
    }
    if (!Number.isFinite(cutoff))
      return { ...result, error: 'Refresh costs to establish the estimate period.' }
    const endDay = costDay(asOf!, timeZone)
    const selected = periods
      .filter((p) => p.key === key)
      .sort((a, b) => Date.parse(a.from) - Date.parse(b.from))
    const invalid = selected.some(
      (p, i) =>
        !Number.isFinite(Date.parse(p.from)) ||
        (p.until !== null &&
          (!Number.isFinite(Date.parse(p.until)) || Date.parse(p.until) <= Date.parse(p.from))) ||
        !Number.isFinite(p.creditsPerHour) ||
        p.creditsPerHour < 0 ||
        !Number.isFinite(p.units) ||
        p.units < 0 ||
        (i > 0 &&
          Date.parse(p.from) <
            (selected[i - 1].until === null ? Infinity : Date.parse(selected[i - 1].until!))),
    )
    if (invalid) return { ...result, error: 'Production estimate configuration needs review.' }
    for (let i = 29; i >= 0; i--) {
      const date = new Date(Date.parse(endDay + 'T00:00:00Z') - i * 86400000)
      const day = date.toISOString().slice(0, 10)
      const next = new Date(date.getTime() + 86400000).toISOString().slice(0, 10)
      const start = costMidnight(day, timeZone)
      const end = Math.min(costMidnight(next, timeZone), cutoff)
      let credits = 0
      let covered = 0
      for (const p of selected) {
        const duration = Math.max(
          0,
          Math.min(end, p.until === null ? Infinity : Date.parse(p.until)) -
            Math.max(start, Date.parse(p.from)),
        )
        covered += duration
        credits += (duration / 3600000) * p.creditsPerHour * p.units
      }
      result.rows.push({
        DAY: day,
        CREDITS:
          covered === end - start &&
          selected.some(
            (p) => Date.parse(p.from) <= start && (p.until === null || Date.parse(p.until) > start),
          )
            ? credits
            : null,
      })
    }
    return result
  })
}
