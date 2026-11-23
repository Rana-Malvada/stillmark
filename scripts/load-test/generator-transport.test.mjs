import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createGeneratorTransport } from './cloud/transport.mjs'

async function fixture(handler, work) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const transport = await createGeneratorTransport(origin, {
    LOAD_TEST_HTTP_PROTOCOL: 'h1',
    LOAD_TEST_HTTP_CONNECTIONS: '2',
  })
  try {
    await work(transport, origin)
  } finally {
    server.closeAllConnections()
    await transport.close()
    await new Promise((resolve) => server.close(resolve))
  }
}
test('bounded transport reuses connections without losing concurrent responses', async () => {
  let active = 0
  let peak = 0
  const sockets = new Set()
  await fixture(
    (req, res) => {
      sockets.add(req.socket)
      peak = Math.max(peak, ++active)
      setTimeout(() => {
        active--
        res.end('ok')
      }, 20)
    },
    async (t, origin) => {
      const responses = await Promise.all(
        Array.from({ length: 12 }, async () => (await t.fetch(origin)).text()),
      )
      assert.deepEqual(responses, Array(12).fill('ok'))
      assert.equal(peak, 2)
      assert.equal(sockets.size, 2)
    },
  )
})
test('transport preserves aborts and rejects cross-origin credential forwarding', async () => {
  let received = 0
  await fixture(
    (req, res) => {
      received++
      setTimeout(() => res.end('late'), 100)
    },
    async (t, origin) => {
      assert.throws(
        () => t.fetch('https://other.invalid', { headers: { Cookie: 'fixture' } }),
        /origin mismatch/,
      )
      assert.equal(received, 0)
      await assert.rejects(t.fetch(origin, { signal: AbortSignal.timeout(20) }), {
        name: 'TimeoutError',
      })
    },
  )
})
test('peer resets remain errors; transport adds no retry loop', async () => {
  let received = 0
  await fixture(
    (req) => {
      received++
      req.socket.destroy()
    },
    async (t, origin) => {
      await assert.rejects(t.fetch(origin))
      assert.equal(received, 1)
    },
  )
})
test('native remains default; invalid bounds fail before traffic', async () => {
  const t = await createGeneratorTransport('https://test.invalid', {})
  assert.equal(t.fetch, globalThis.fetch)
  for (const env of [
    { LOAD_TEST_HTTP_PROTOCOL: 'invalid' },
    { LOAD_TEST_HTTP_PROTOCOL: 'h2', LOAD_TEST_HTTP_CONNECTIONS: '0' },
    { LOAD_TEST_HTTP_PROTOCOL: 'h2', LOAD_TEST_HTTP_STREAMS: '100000' },
  ])
    await assert.rejects(createGeneratorTransport('https://test.invalid', env))
})

test('native multipart upload bodies preserve file bytes and fields', async () => {
  await fixture(
    async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      try {
        const decoded = await new Request('http://fixture.invalid', {
          method: 'POST',
          headers: req.headers,
          body: Buffer.concat(chunks),
        }).formData()
        res.end(JSON.stringify({ id: decoded.get('id'), file: await decoded.get('chunk').text() }))
      } catch {
        res.writeHead(400)
        res.end('Invalid multipart')
      }
    },
    async (t, origin) => {
      const form = new FormData()
      form.set('id', 'fixture-id')
      form.set('chunk', new Blob(['fixture-file-bytes']), 'fixture.jpg')
      const response = await t.fetch(origin, { method: 'POST', body: form })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { id: 'fixture-id', file: 'fixture-file-bytes' })
    },
  )
})

test('HTTP/2 multiplexes bounded streams and refuses HTTP/1 fallback', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const { createSecureServer } = await import('node:http2')
  const { createServer: httpsServer } = await import('node:https')
  const dir = await mkdtemp(join(tmpdir(), 'stillmark-h2-test-'))
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    )
    const tls = {
      key: await readFile(join(dir, 'key.pem')),
      cert: await readFile(join(dir, 'cert.pem')),
    }
    const server = createSecureServer(tls)
    let active = 0
    let peak = 0
    server.on('stream', (stream) => {
      peak = Math.max(peak, ++active)
      setTimeout(() => {
        active--
        stream.respond({ ':status': 200 })
        stream.end('ok')
      }, 25)
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const origin = `https://127.0.0.1:${server.address().port}`
    const env = {
      LOAD_TEST_HTTP_PROTOCOL: 'h2',
      LOAD_TEST_HTTP_CONNECTIONS: '1',
      LOAD_TEST_HTTP_STREAMS: '4',
    }
    const transport = await createGeneratorTransport(origin, env, { ca: tls.cert })
    try {
      await Promise.all(
        Array.from({ length: 12 }, async () => {
          const r = await transport.fetch(origin, { signal: AbortSignal.timeout(3000) })
          assert.equal(await r.text(), 'ok')
        }),
      )
      assert.equal(peak, 4, 'must multiplex, without exceeding the stream limit')
    } finally {
      await transport.close()
      await new Promise((r) => server.close(r))
    }
    const h1 = httpsServer(tls, (_req, res) => res.end('must not pipeline HTTP/1'))
    await new Promise((r) => h1.listen(0, '127.0.0.1', r))
    const h1Origin = `https://127.0.0.1:${h1.address().port}`
    const strict = await createGeneratorTransport(h1Origin, env, { ca: tls.cert })
    try {
      await assert.rejects(
        strict.fetch(h1Origin, { signal: AbortSignal.timeout(3000) }),
        (error) => error.cause?.message === 'HTTP/2 diagnostic requires negotiated h2',
      )
    } finally {
      await strict.close()
      h1.closeAllConnections()
      await new Promise((r) => h1.close(r))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
