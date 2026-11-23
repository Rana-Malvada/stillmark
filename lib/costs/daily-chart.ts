export type ReportRow = Record<string, string | number | null>
export interface DailySeries {
  name: string
  values: (number | null)[]
}
export interface DailyData {
  days: string[]
  series: DailySeries[]
}

/** Usage may fill absent days with zero; explicit unavailable values and storage gaps stay null. Dates are UTC. */
export function dailyData(
  rows: ReportRow[],
  metrics: { key: string; label: string }[],
  end: string,
  count = 30,
  group?: string,
  missing: number | null = null,
): DailyData {
  const last = new Date(end.slice(0, 10) + 'T00:00:00Z')
  if (!Number.isFinite(last.getTime())) return { days: [], series: [] }
  const days = Array.from({ length: count }, (_, i) =>
    new Date(last.getTime() - (count - 1 - i) * 86400000).toISOString().slice(0, 10),
  )
  const series = new Map<string, DailySeries>()
  const unavailable = new Set<string>()
  if (missing !== null && (!group || rows.length === 0)) {
    for (const metric of metrics)
      series.set(metric.label, { name: metric.label, values: Array(count).fill(missing) })
  }
  for (const row of rows) {
    const day = String(row.DAY ?? row.day ?? '').slice(0, 10)
    const index = days.indexOf(day)
    if (index < 0) continue
    for (const metric of metrics) {
      const raw = row[metric.key]
      const name = group ? String(row[group] ?? 'Unspecified') : metric.label
      const current = series.get(name) ?? { name, values: Array(count).fill(missing) }
      const value = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
      const cell = JSON.stringify([name, index])
      if (!Number.isFinite(value)) {
        if (missing === null) continue
        unavailable.add(cell)
        current.values[index] = null
      } else if (!unavailable.has(cell))
        current.values[index] = (current.values[index] ?? 0) + value
      series.set(name, current)
    }
  }
  return { days, series: [...series.values()] }
}

export const costMetrics: Record<
  string,
  { metrics: { key: string; label: string }[]; group?: string }
> = {
  cloud_services: { metrics: [{ key: 'CREDITS', label: 'Cloud services (before adjustments)' }] },
  photo_rest: { metrics: [{ key: 'CREDITS', label: 'Estimated AI credits' }], group: 'MODEL_NAME' },
  faces: { metrics: [{ key: 'CREDITS', label: 'Credits' }], group: 'COMPUTE_POOL_NAME' },
  warehouse: {
    metrics: [
      { key: 'COMPUTE_CREDITS', label: 'Compute' },
      { key: 'CLOUD_SERVICES_CREDITS', label: 'Cloud services' },
    ],
  },
  ai: { metrics: [{ key: 'CREDITS', label: 'Credits' }], group: 'MODEL_NAME' },
  search: { metrics: [{ key: 'CREDITS', label: 'Credits' }], group: 'SERVICE_NAME' },
  runtime: { metrics: [{ key: 'CREDITS', label: 'Credits' }] },
  postgres: { metrics: [{ key: 'CREDITS', label: 'Credits' }] },
}
