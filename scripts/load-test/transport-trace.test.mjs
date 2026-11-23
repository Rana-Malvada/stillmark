import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { transportTrace } from './transport-trace.mjs'

test('collects real fetch lifecycle without headers or body', async () => {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => res.end('private response'))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const trace = transportTrace()
    const res = await trace.run(() =>
      fetch(`http://127.0.0.1:${server.address().port}`, {
        method: 'POST',
        body: 'secret',
        headers: { Authorization: 'secret' },
      }),
    )
    await res.text()
    const data = trace.finish()
    for (const key of [
      'createdMs',
      'sentHeadersMs',
      'bodySentMs',
      'responseHeadersMs',
      'responseCompleteMs',
      'socketId',
      'socketRequest',
    ])
      assert.equal(typeof data[key], 'number', key)
    assert.ok(data.responseHeadersMs >= data.sentHeadersMs)
    assert.ok(Object.values(data).every((x) => typeof x === 'number'))
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
test('retains only an allowlisted code when the peer closes before headers', async () => {
  const server = createServer((req) => req.socket.destroy())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const trace = transportTrace()
    await assert.rejects(trace.run(() => fetch(`http://127.0.0.1:${server.address().port}`)))
    const data = trace.finish()
    assert.equal(data.errorCode, 'UND_ERR_SOCKET')
    assert.equal(typeof data.transportErrorMs, 'number')
    assert.ok(!JSON.stringify(data).includes('127.0.0.1'))
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
test('disabled diagnostics preserve work, its original promise and errors', async () => {
  const trace = transportTrace({ enabled: false })
  const work = Promise.resolve(42)
  assert.equal(
    trace.run(() => work),
    work,
  )
  assert.equal(await work, 42)
  assert.deepEqual(trace.finish(), {})
  assert.throws(
    () =>
      trace.run(() => {
        throw new Error('expected')
      }),
    /expected/,
  )
  await assert.rejects(
    trace.run(() => Promise.reject(new Error('expected'))),
    /expected/,
  )
})
test('distinguishes a TCP reset before headers from a successful response', async () => {
  const server = createServer((req) => req.socket.resetAndDestroy())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const trace = transportTrace()
    await assert.rejects(trace.run(() => fetch(`http://127.0.0.1:${server.address().port}`)))
    const data = trace.finish()
    assert.equal(data.errorCode, 'ECONNRESET')
    assert.equal(data.socketBytesRead, 0)
    assert.ok(data.socketBytesWritten > 0)
    assert.equal(data.responseHeadersMs, undefined)
    assert.equal(data.socketDestroyed, 1)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
