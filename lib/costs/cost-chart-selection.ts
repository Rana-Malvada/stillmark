/** An empty selection is All: use the server's reconciled total, not a sum of visible lines. */
export function toggleCostType(selected: string[], key: string): string[] {
  return selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]
}
export function costChartMetrics(selected: string[], services: { key: string; label: string }[]) {
  return selected.length
    ? services.filter((s) => selected.includes(s.key)).map(({ key, label }) => ({ key, label }))
    : [{ key: 'usd', label: 'Total cost' }]
}
