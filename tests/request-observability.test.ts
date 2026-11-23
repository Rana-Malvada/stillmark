import { afterEach, expect, it, vi } from 'vitest'
import { createDiagnosticWriter, safeDiagnostic } from '@/lib/observability/production-diagnostics'
import {
  observePhase,
  observeRequest,
  withoutRequestObservation,
} from '@/lib/request-observability'
import { flushPerformance, recordPerformance } from '@/lib/observability/performance-metrics'

afterEach(() => {
  flushPerformance()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
it('preserves a nested connection reset and correlation but never free text', async () => {
  const out: string[] = []
  const write = createDiagnosticWriter((line) => out.push(line))
  vi.spyOn(console, 'error').mockImplementation((...args) => write('error', args))
  vi.spyOn(console, 'warn').mockImplementation((...args) => write('warn', args))
  const id = '12345678-1234-1234-1234-123456789012'
  const error = new Error('secret photo URL', {
    cause: Object.assign(new Error('password'), { code: 'ECONNRESET' }),
  })
  await expect(
    observeRequest(
      new Request('https://app/api/images?path=private', { headers: { 'x-photo-request-id': id } }),
      () =>
        observePhase('media-fetch-headers', async () => {
          throw error
        }),
    ),
  ).rejects.toBe(error)
  const rows = out.map((line) => JSON.parse(line))
  expect(rows[0]).toMatchObject({
    event: 'request-phase',
    id,
    route: 'media',
    phase: 'media-fetch-headers',
    code: 'ECONNRESET',
  })
  expect(rows[1]).toMatchObject({ event: 'request-headers', id, status: 500 })
  expect(out.join('')).not.toMatch(/secret|password|private/)
})
it('separates category budgets and reports dropped counts during a quiet interval', () => {
  vi.useFakeTimers()
  const out: string[] = []
  const write = createDiagnosticWriter((line) => out.push(line))
  for (let i = 0; i < 50; i++) write('warn', ['[maintenance]', new Error('secret')])
  write('error', ['[request]', Object.assign(new Error('secret'), { code: 'ECONNRESET' })])
  expect(out).toHaveLength(31)
  expect(JSON.parse(out[30])).toMatchObject({ event: 'request', code: 'ECONNRESET' })
  vi.advanceTimersByTime(60000)
  expect(JSON.parse(out[31])).toMatchObject({
    event: 'diagnostics-dropped',
    category: 'maintenance',
    count: 20,
  })
})
it('flushes histograms without another request and rejects unknown metric names', () => {
  vi.useFakeTimers()
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  recordPerformance('gateway-user-refresh', 4)
  recordPerformance('gateway-user-refresh', 10001, 1, true)
  recordPerformance('SECRET', 1)
  vi.advanceTimersByTime(60000)
  expect(log).toHaveBeenCalledTimes(1)
  const d = safeDiagnostic(log.mock.calls[0])
  expect(d).toMatchObject({
    event: 'performance',
    metric: 'gateway-user-refresh',
    count: 2,
    failures: 1,
    queued: 1,
  })
  expect('buckets' in d && (d.buckets as number[]).reduce((a, b) => a + b)).toBe(2)
})
it('separates request concurrency and does not instrument detached background work', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await observeRequest(new Request('https://app/api/events'), async () => {
    await withoutRequestObservation(() => observePhase('db-query', async () => {}))
    return Response.json({ ok: true })
  })
  expect(log).not.toHaveBeenCalled()
})

it('keeps concurrent failure phases attached to their own request IDs', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
  const run = (id: string, wait: Promise<void>) =>
    observeRequest(
      new Request('https://app/api/photos', { headers: { 'x-photo-request-id': id } }),
      async () =>
        observePhase('db-query', async () => {
          await wait
          throw Object.assign(new Error('private'), { code: 'ECONNRESET' })
        }),
    ).catch(() => {})
  const first = run(ids[0], gate)
  await run(ids[1], Promise.resolve())
  release()
  await first
  expect(log.mock.calls.map((args) => (safeDiagnostic(args) as { id: string }).id)).toEqual([
    ids[1],
    ids[0],
  ])
})
