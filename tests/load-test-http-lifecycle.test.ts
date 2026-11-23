import { createServer, get } from 'node:http'
import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import { installLoadTestHttpLifecycle } from '@/lib/load-test-http-lifecycle'
import { loadTestRequestEvidence } from '@/lib/load-test-request-journal'

it('distinguishes handler streaming from actual HTTP completion and retains repeated attempts', async () => {
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('PG_DATABASE', 'stillmark_loadtest_lifecycle')
  installLoadTestHttpLifecycle()
  const id = '10000000-0000-4000-8000-000000000001'
  let finish: () => void = () => {}
  const server = createServer((_req, res) => {
    res.write('first')
    finish = () => res.end('last')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    for (let i = 0; i < 2; i++) {
      const port = (server.address() as { port: number }).port
      const req = get({ host: '127.0.0.1', port, headers: { 'x-load-test-request': id } })
      const [res] = await once(req, 'response')
      res.resume()
      const attempt = loadTestRequestEvidence([id])!.records[id]!.http![i]
      expect(attempt.startedAt).toBeGreaterThan(0)
      expect(attempt.finishedAt).toBeUndefined()
      finish()
      await once(res, 'end')
      expect(attempt.finishedAt).toBeGreaterThanOrEqual(attempt.startedAt)
      expect(attempt.completed).toBe(true)
      expect(attempt.socket?.requestNumber).toBeGreaterThan(0)
    }
    expect(loadTestRequestEvidence([id])!.records[id]!.http).toHaveLength(2)
  } finally {
    server.closeAllConnections()
    server.close()
    vi.unstubAllEnvs()
  }
})

it('records a peer disconnect before a response without attributing it to handler completion', async () => {
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('PG_DATABASE', 'stillmark_loadtest_lifecycle')
  installLoadTestHttpLifecycle()
  const id = '10000000-0000-4000-8000-000000000002'
  let entered!: () => void
  const arrival = new Promise<void>((resolve) => {
    entered = resolve
  })
  let closed!: Promise<unknown>
  const server = createServer((req) => {
    closed = once(req.socket, 'close')
    entered()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const req = get({
      host: '127.0.0.1',
      port: (server.address() as { port: number }).port,
      headers: { 'x-load-test-request': id },
    })
    req.on('error', () => {})
    await arrival
    req.destroy()
    await closed
    const attempt = loadTestRequestEvidence([id])!.records[id]!.http![0]
    expect(attempt.finishedAt).toBeUndefined()
    expect(attempt.completed).toBe(false)
    expect(attempt.socket?.closedAt).toBeGreaterThanOrEqual(attempt.startedAt)
    expect(typeof attempt.socket?.hadError).toBe('boolean')
    expect(attempt.socket?.timeoutAt).toBeUndefined()
  } finally {
    server.closeAllConnections()
    server.close()
    vi.unstubAllEnvs()
  }
})
