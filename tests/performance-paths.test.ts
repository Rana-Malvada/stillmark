import { afterEach, expect, it, vi } from 'vitest'
import { clearGridCaches, GridCache } from '@/lib/grid-cache'
import { visibleRows } from '@/components/virtual-photo-grid'
import { safeDiagnostic } from '@/lib/observability/production-diagnostics'

afterEach(() => {
  vi.useRealTimers()
  clearGridCaches()
})
it('bounds snapshots, isolates keys, expires them without sliding reads, and clears on logout', () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const cache = new GridCache<number>(6, 30000)
  cache.put('ALICE:1', [1, 2, 3], 'next')
  cache.put('BOB:1', [4, 5, 6], null)
  expect(cache.get('ALICE:1')?.items).toEqual([1, 2, 3])
  cache.put('ALICE:2', [7], null)
  expect(cache.get('ALICE:1')).toBeNull()
  vi.advanceTimersByTime(29999)
  expect(cache.get('BOB:1')).not.toBeNull()
  vi.advanceTimersByTime(1)
  expect(cache.get('BOB:1')).toBeNull()
  cache.put('BOB:2', [8], null)
  clearGridCaches()
  expect(cache.get('BOB:2')).toBeNull()
  cache.put('huge', [1, 2, 3, 4, 5, 6, 7], null)
  expect(cache.get('huge')).toBeNull()
})
it('bounds rendered rows for a million photos, keeps scroll geometry and handles breakpoints', () => {
  for (const columns of [3, 4, 5, 6, 7, 8, 10]) {
    const r = visibleRows(1000000, columns, 1200, 100000, 800)
    expect(r.end - r.start).toBeLessThan(20)
    expect(r.start).toBeGreaterThan(0)
    expect(r.rows).toBe(Math.ceil(1000000 / columns))
  }
  expect(visibleRows(0, 3, 360, 0, 800).end).toBe(0)
  const end = visibleRows(547, 3, 360, 1e8, 800)
  expect(end.end).toBe(end.rows)
  expect(end.start).toBeLessThan(end.rows)
})
it('keeps diagnostics numeric and strips identifiers even from performance events', () => {
  expect(
    safeDiagnostic([
      '[performance]',
      {
        metric: 'database-pool',
        count: 5,
        totalMs: 14,
        maxMs: 8,
        queued: 2,
        failures: 0,
        sql: 'SECRET',
        username: 'ALICE',
      },
    ]),
  ).toEqual({
    event: 'performance',
    metric: 'database-pool',
    count: 5,
    totalMs: 14,
    maxMs: 8,
    queued: 2,
    failures: 0,
  })
  expect(safeDiagnostic(['[performance]', { metric: 'ALICE', count: 5 }])).toEqual({
    event: 'application',
  })
})
