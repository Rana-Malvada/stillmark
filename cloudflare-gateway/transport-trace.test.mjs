import { test } from 'node:test'
import assert from 'node:assert/strict'
import { traceTransport } from './transport-trace.mjs'

const id = crypto.randomUUID()
const req = new Request('https://example.com/api/images', {
  headers: { 'x-load-test-request': id },
})
const env = {
  LOAD_TEST_TRANSPORT_TRACE: 'true',
  GATEWAY_ORIGIN: 'https://stillmark-loadtest-baseline.example.workers.dev',
}
test('production profiles and non-test origins cannot enable transport logs', () => {
  const f = () => {}
  assert.equal(traceTransport(req, env, f, { DATABASE: 'PERSONAL_MEDIA' }), f)
  assert.equal(
    traceTransport(req, { ...env, GATEWAY_ORIGIN: 'https://photos.example.com' }, f, {
      DATABASE: 'STILLMARK_LOADTEST_BASELINE',
    }),
    f,
  )
})
test('failure logs contain correlation and phase without credentials', async () => {
  const logs = []
  const e = { ...env, GATEWAY_ORIGIN: 'https://stillmark-loadtest-baseline.example.workers.dev' }
  const f = traceTransport(
    req,
    e,
    async () => {
      throw Error('secret')
    },
    { DATABASE: 'STILLMARK_LOADTEST_BASELINE' },
    (x) => logs.push(JSON.parse(x)),
  )
  await assert.rejects(f('https://storage.example.com/private?signature=secret', {}))
  assert.equal(logs.length, 1)
  assert.equal(logs[0].id, id)
  assert.equal(logs[0].phase, 'storage')
  assert.equal(logs[0].status, 0)
  assert.equal(JSON.stringify(logs).includes('secret'), false)
})
