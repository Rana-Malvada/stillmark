import { afterEach, expect, it, vi } from 'vitest'
import {
  beginLoadTestHttp,
  loadTestRequestEvidence,
  recordLoadTestRequest,
} from '@/lib/load-test-request-journal'

afterEach(() => {
  vi.unstubAllEnvs()
  delete (globalThis as any)[Symbol.for('stillmark.isolated.request.journal')]
})
const id = '00000000-0000-4000-8000-000000000001'
it('does not retain production requests even with tracing enabled', () => {
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('PG_DATABASE', 'postgres')
  recordLoadTestRequest(id, { proxyAt: 1 })
  expect(loadTestRequestEvidence([id])).toBeNull()
})
it('correlates proxy and handler without overwriting the arrival evidence', () => {
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('PG_DATABASE', 'stillmark_loadtest_trace')
  recordLoadTestRequest(id, { proxyAt: 1 })
  recordLoadTestRequest(id, { enteredAt: 2, event: 'pending', active: ['db-checkout'] })
  const evidence = loadTestRequestEvidence([id])!
  expect(evidence.received).toBe(1)
  expect(evidence.records[id]).toMatchObject({ proxyAt: 1, enteredAt: 2, active: ['db-checkout'] })
  expect(() => loadTestRequestEvidence(['secret'])).toThrow('Invalid trace IDs')
})
it('bounds retention and exposes eviction rather than treating missing evidence as proof', () => {
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('PG_DATABASE', 'stillmark_loadtest_trace')
  for (let i = 0; i < 50001; i++)
    recordLoadTestRequest(`00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, {
      event: 'returned',
      status: 200,
    })
  expect(loadTestRequestEvidence(['00000000-0000-4000-8000-000000000000'])).toMatchObject({
    retained: 50000,
    received: 50001,
    evicted: 1,
    records: { '00000000-0000-4000-8000-000000000000': null },
  })
})

it('preserves first arrival when the same request identifier reaches the app again', () => {
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('PG_DATABASE', 'stillmark_loadtest_trace')
  recordLoadTestRequest(id, { proxyAt: 10, enteredAt: 20 })
  recordLoadTestRequest(id, { proxyAt: 100, enteredAt: 200 })
  for (let i = 0; i < 10; i++) beginLoadTestHttp(id)
  expect(loadTestRequestEvidence([id])!.records[id]).toMatchObject({ proxyAt: 10, enteredAt: 20 })
  expect(loadTestRequestEvidence([id])!.records[id]!.http).toHaveLength(4)
})
