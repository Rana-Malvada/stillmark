import { afterEach, expect, it, vi } from 'vitest'
import { traceUploadRequest, uploadRequestStep } from '../lib/upload/upload-request-trace'
import { createServer, request } from 'node:http'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
const id = '00000000-0000-4000-8000-000000000000'
const req = () =>
  new Request('https://example.test/api/upload/status', {
    headers: { 'x-load-test-request': id, Authorization: 'secret' },
  })
it('does not trace a production database even when flag is enabled', async () => {
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('PG_DATABASE', 'postgres')
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const response = await traceUploadRequest(async () => Response.json({ ok: true }))(req())
  expect(out).not.toHaveBeenCalled()
  expect(response.headers.get('x-load-test-request')).toBeNull()
})
it('correlates isolated phases without retaining private request or response data', async () => {
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('PG_DATABASE', 'stillmark_loadtest_trace')
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const response = await traceUploadRequest(async () => {
    await uploadRequestStep('auth', async () => 'private-user')
    return Response.json({ token: 'secret-response' })
  })(req())
  expect(response.headers.get('x-load-test-request')).toBe(id)
  const logs = out.mock.calls.map((x) => String(x[0])).join('')
  expect(logs).toContain('entered')
  expect(logs).toContain('returned')
  expect(logs).toContain('auth')
  expect(logs).not.toMatch(/secret|private-user|example/)
})
it('preserves errors and clears tracing state', async () => {
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('PG_DATABASE', 'stillmark_loadtest_trace')
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const error = new Error('private failure')
  await expect(
    traceUploadRequest(async () => {
      throw error
    })(req()),
  ).rejects.toBe(error)
  expect(out.mock.calls.map((x) => String(x[0])).join('')).not.toContain('private failure')
  await expect(uploadRequestStep('auth', async () => 42)).resolves.toBe(42)
})

it('records cache behavior without logging or retaining raw authentication keys', async () => {
  const { observeUploadAuthKey, uploadTraceCount, uploadTraceGauge } =
    await import('../lib/upload/upload-request-trace')
  const unusedScope = vi.fn(() => 'private-scope')
  observeUploadAuthKey(unusedScope, 'private-key')
  expect(unusedScope).not.toHaveBeenCalled()
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('PG_DATABASE', 'stillmark_loadtest_trace')
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  await traceUploadRequest(async () => {
    observeUploadAuthKey(() => 'private-scope', 'private-key-one')
    observeUploadAuthKey(() => 'private-scope', 'private-key-one')
    observeUploadAuthKey(() => 'private-scope', 'private-key-two')
    uploadTraceCount('role-cache-hit')
    uploadTraceGauge('caller-pools', 2)
    return Response.json({ ok: true })
  })(req())
  const logs = out.mock.calls.map((x) => String(x[0])).join('')
  expect(logs).toContain('auth-context-token-changed')
  expect(logs).toContain('auth-context-same-token')
  expect(logs).toContain('role-cache-hit')
  expect(logs).toContain('"caller-pools":2')
  expect(logs).not.toMatch(/private-|secret/)
})

it('observes real HTTP attempts and retry counters without recording sensitive transport data', async () => {
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('PG_DATABASE', 'stillmark_loadtest_trace')
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const server = createServer((_req, res) => {
    res.writeHead(503)
    res.end('private response')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    const send = (
      host: string,
      path = '/queries/v1/query-request?retryCount=2&requestId=private-id',
    ) =>
      new Promise<void>((resolve, reject) => {
        const r = request(
          {
            hostname: 'localhost',
            family: 4,
            port,
            path,
            method: 'POST',
            headers: { Host: host, Authorization: 'private-token' },
          },
          (res) => {
            res.resume()
            res.once('end', resolve)
          },
        )
        r.on('error', reject)
        r.end('private SQL')
      })
    await traceUploadRequest(async () => {
      await send('private-account.snowflakecomputing.com')
      await send('unrelated.example')
      await send('private-account.snowflakecomputing.com', '/queries/private-id/result')
      await send('private-account.snowflakecomputing.com', '/queries/v1/abort-request')
      return Response.json({ ok: true })
    })(req())
    const logs = out.mock.calls.map((x) => String(x[0])).join('')
    expect(logs).toContain('"sf-http-query-attempts":1')
    expect(logs).toContain('"sf-http-query-retry-attempts":1')
    expect(logs).toContain('"sf-http-query-retry-max":2')
    expect(logs).toContain('"sf-http-query-status-503":1')
    expect(logs).toContain('sf-http-query-headers-ms')
    expect(logs).toContain('sf-http-query-socket-assigned')
    expect(logs).toContain('sf-http-query-connect-attempt-ipv4')
    expect(logs).toContain('sf-http-query-sent-ms')
    expect(logs).toContain('"sf-http-result-attempts":1')
    expect(logs).not.toMatch(/private|unrelated|query-request|Authorization/)
    out.mockClear()
    // An installed subscriber remains inert outside an isolated request context.
    await send('private-account.snowflakecomputing.com')
    expect(out).not.toHaveBeenCalled()
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

it('records a reset code and send phase without leaking the transport error', async () => {
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('PG_DATABASE', 'stillmark_loadtest_trace')
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const server = createServer((incoming) => incoming.socket.destroy())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    await traceUploadRequest(async () => {
      await new Promise<void>((resolve) => {
        const outgoing = request({
          hostname: 'localhost',
          family: 4,
          port,
          path: '/queries/v1/query-request?requestId=private-id',
          headers: { Host: 'private-account.snowflakecomputing.com' },
        })
        outgoing.once('error', () => resolve())
        outgoing.end()
      })
      return Response.json({ ok: true })
    })(req())
    const logs = out.mock.calls.map((x) => String(x[0])).join('')
    expect(logs).toContain('"sf-http-query-error-ECONNRESET":1')
    expect(logs).toContain('sf-http-query-sent-ms')
    expect(logs).not.toMatch(/private|127\.0\.0\.1|hang up|query-request/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  }
})

it('forwards route parameters and avoids nested tracing contexts', async () => {
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('PG_DATABASE', 'stillmark_loadtest_trace')
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const params = { params: Promise.resolve({ eventId: '42' }) }
  const handler = traceUploadRequest(
    traceUploadRequest(async (_req: Request, ctx: typeof params) => {
      expect(ctx).toBe(params)
      return Response.json(await ctx.params)
    }),
  )
  expect(await (await handler(req(), params)).json()).toEqual({ eventId: '42' })
  expect(out.mock.calls.filter((x) => String(x[0]).includes('"event":"entered"'))).toHaveLength(1)
})

it('retains safe counters and cancellation timing when trace stdout is disabled', async () => {
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('UPLOAD_REQUEST_TRACE_LOG', 'false')
  vi.stubEnv('PG_DATABASE', 'stillmark_loadtest_trace')
  const { loadTestRequestEvidence } = await import('../lib/load-test-request-journal')
  const { uploadTraceCount } = await import('../lib/upload/upload-request-trace')
  const controller = new AbortController()
  await traceUploadRequest(async () => {
    uploadTraceCount('media-fetch-aborted')
    controller.abort(new Error('private cancellation'))
    return new Response(null, { status: 500 })
  })(
    new Request('https://example.test', {
      signal: controller.signal,
      headers: { 'x-load-test-request': id },
    }),
  )
  const entry = loadTestRequestEvidence([id])!.records[id]!
  expect(entry.counts).toEqual({ 'media-fetch-aborted': 1 })
  expect(entry.abortedAt).toBeGreaterThan(0)
  expect(JSON.stringify(entry)).not.toContain('private cancellation')
})

it('samples detailed phases while keeping a lightweight total timer on other isolated requests', async () => {
  vi.stubEnv('UPLOAD_REQUEST_TRACE', 'true')
  vi.stubEnv('UPLOAD_REQUEST_TRACE_LOG', 'false')
  vi.stubEnv('PG_DATABASE', 'stillmark_loadtest_trace')
  vi.stubEnv('LOAD_TEST_REQUEST_SAMPLE_EVERY', '64')
  const { loadTestRequestEvidence } = await import('../lib/load-test-request-journal')
  const unsampled = '00000001-0000-4000-8000-000000000123'
  const sampled = '00000040-0000-4000-8000-000000000123'
  const handler = traceUploadRequest(async () => {
    await uploadRequestStep('test-phase', async () => undefined)
    return Response.json({ ok: true })
  })
  for (const requestId of [unsampled, sampled]) {
    const response = await handler(
      new Request('https://example.test/api/events', {
        headers: { 'x-load-test-request': requestId },
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('server-timing')).toMatch(/^app;dur=[0-9.]+$/)
  }
  expect(loadTestRequestEvidence([unsampled])!.records[unsampled]).toBeNull()
  expect(loadTestRequestEvidence([sampled])!.records[sampled]!.phases).toHaveProperty('test-phase')
  expect(loadTestRequestEvidence([])!.recentIds).toContain(sampled)
  expect(loadTestRequestEvidence([])!.recentIds).not.toContain(unsampled)
})
