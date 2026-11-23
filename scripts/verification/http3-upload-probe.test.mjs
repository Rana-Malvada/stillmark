import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createProbeWorker } from './http3-upload-probe-worker.mjs'
import { CLIENT, PAGE } from './http3-upload-probe-page.mjs'
import {
  BASE_PATH,
  MAX_BODY,
  MAX_PLAN_BYTES,
  PLAN,
  PLAN_BYTES,
  PROBE_ORIGIN,
  PROBE_WORKER,
  WINDOW_MS,
} from './http3-upload-probe-plan.mjs'
import { probeConfig } from './http3-upload-probe-prepare.mjs'

const token = 'a'.repeat(64)
const env = {
  UPLOAD_PROBE_TOKEN: token,
  PROBE_RUN_ID: '12345678-1234-4123-8123-123456789012',
  PROBE_START_MS: '1',
  PROBE_END_MS: String(WINDOW_MS),
}
function request(
  slot,
  {
    body,
    bytes = PLAN[slot - 1].wireBytes,
    protocol = 'HTTP/2',
    origin = PROBE_ORIGIN,
    authorization = 'Bearer ' + token,
    signal,
    length,
  } = {},
) {
  const headers = { authorization, origin, 'sec-fetch-site': 'same-origin' }
  if (length !== undefined) headers['content-length'] = String(length)
  const req = new Request(PROBE_ORIGIN + BASE_PATH + '/upload/' + slot, {
    method: 'POST',
    headers,
    body: body ?? new Uint8Array(bytes),
    duplex: 'half',
    signal,
  })
  Object.defineProperty(req, 'cf', {
    value: { httpProtocol: protocol, colo: 'ATL', clientTcpRtt: 10 },
  })
  return req
}
const worker = (options = {}) => createProbeWorker({ now: () => 10, log: () => {}, ...options })

test('fixed twenty-attempt plan stays below48MiB and uses only synthetic data', () => {
  assert.equal(PLAN.length, 20)
  assert.equal(new Set(PLAN.map((p) => p.slot)).size, 20)
  assert.ok(PLAN_BYTES < MAX_PLAN_BYTES)
  assert.ok(PLAN.every((p) => p.wireBytes <= MAX_BODY))
  assert.doesNotMatch(
    PAGE + CLIENT,
    /type=["']file|localStorage|document\.cookie|credentials:\s*['"]include/,
  )
  new vm.Script(CLIENT)
})

test('keepNames worker bundle emits a self-contained browser client with working handlers', async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./http3-upload-probe-worker.mjs', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'ProbeWorker',
    keepNames: true,
  })
  const workerContext = vm.createContext({ Request, Response, URL, setTimeout, clearTimeout })
  new vm.Script(bundle.outputFiles[0].text).runInContext(workerContext)
  const bundledWorker = workerContext.ProbeWorker.createProbeWorker({ now: () => 10, log() {} })
  const response = await bundledWorker.fetch(
    new Request(PROBE_ORIGIN + BASE_PATH + '/client.js'),
    env,
  )
  assert.equal(response.status, 200)
  assert.doesNotMatch(response.headers.get('Content-Security-Policy'), /unsafe-eval/)
  const emitted = await response.text()
  const elements = new Map(
    ['results', 'status', 'token', 'check', 'h2', 'h3', 'stop'].map((id) => [
      id,
      { value: id === 'token' ? token : '', textContent: '', disabled: false },
    ]),
  )
  let requests = 0
  const browserContext = vm.createContext(
    {
      document: { getElementById: (id) => elements.get(id) },
      window: {},
      AbortSignal,
      fetch: async (url, options) => {
        requests++
        assert.equal(url, BASE_PATH + '/status')
        assert.equal(options.headers.Authorization, 'Bearer ' + token)
        assert.equal(options.credentials, 'omit')
        return { ok: true, json: async () => ({ protocol: 'h3', colo: 'ATL', remainingMs: 1000 }) }
      },
    },
    { codeGeneration: { strings: false, wasm: false } },
  )
  // No worker-side esbuild helpers are supplied to the separate browser realm.
  new vm.Script(emitted).runInContext(browserContext, { timeout: 1000 })
  for (const id of ['check', 'h2', 'h3', 'stop'])
    assert.equal(typeof elements.get(id).onclick, 'function')
  await elements.get('check').onclick()
  assert.equal(elements.get('status').textContent, 'Connection checked.')
  assert.equal(elements.get('token').value, '')
  assert.equal(requests, 1)
  assert.equal(browserContext.window.__uploadProbeResults[0].protocol, 'h3')
  assert.doesNotMatch(JSON.stringify(browserContext.window.__uploadProbeResults), new RegExp(token))
  await elements.get('h2').onclick()
  assert.equal(
    elements.get('status').textContent,
    'Actual connection protocol does not match selected lane.',
  )
  for (const id of ['check', 'h2', 'h3']) assert.equal(elements.get(id).disabled, false)
  elements.get('stop').onclick()
  assert.equal(elements.get('status').textContent, 'Stopped by operator.')
})

test('wrong token, origin, expired window, and production hostname do not consume the body', async () => {
  const w = worker()
  let pulls = 0
  const body = () =>
    new ReadableStream(
      {
        pull() {
          pulls++
        },
      },
      { highWaterMark: 0 },
    )
  assert.equal(
    (await w.fetch(request(1, { authorization: 'Bearer wrong', body: body() }), env)).status,
    401,
  )
  assert.equal(
    (await w.fetch(request(1, { origin: 'https://untrusted.invalid', body: body() }), env)).status,
    403,
  )
  assert.equal(
    (await w.fetch(request(1, { body: body() }), { ...env, PROBE_END_MS: '9' })).status,
    410,
  )
  assert.equal(
    (await w.fetch(new Request('https://photos.stillmark.example' + BASE_PATH), env)).status,
    404,
  )
  assert.equal(pulls, 0)
})

test('drain and buffer return exact byte totals with safe numeric phase records', async () => {
  const records = []
  const w = worker({ log: (s) => records.push(JSON.parse(s)) })
  for (const slot of [1, 2]) {
    const response = await w.fetch(request(slot), env)
    const result = await response.json()
    assert.equal(response.status, 200)
    assert.equal(result.bytes, PLAN[slot - 1].wireBytes)
    assert.equal(result.protocol, 'h2')
    assert.equal(result.connectionReuse, 'unknown')
  }
  assert.deepEqual(
    records.map((r) => r.phase),
    ['entry', 'first_byte', 'end', 'entry', 'first_byte', 'end'],
  )
  assert.doesNotMatch(
    JSON.stringify(records),
    new RegExp(token + '|authorization|cookie|body|filename|http[s]?:'),
  )
})

test('early rejection performs no read and does not prevent the next planned upload', async () => {
  let pulls = 0
  const w = worker()
  const rejected = await w.fetch(
    request(3, {
      body: new ReadableStream(
        {
          pull() {
            pulls++
          },
        },
        { highWaterMark: 0 },
      ),
    }),
    env,
  )
  assert.equal(rejected.status, 413)
  assert.equal((await rejected.json()).reason, 'deliberate_reject')
  assert.equal(pulls, 0)
  assert.equal((await w.fetch(request(4), env)).status, 200)
})

test('protocol mismatch and replay cannot produce a passing result', async () => {
  const w = worker()
  const mismatch = await w.fetch(request(1, { protocol: 'HTTP/3' }), env)
  assert.equal(mismatch.status, 409)
  assert.equal((await mismatch.json()).reason, 'protocol_mismatch')
  assert.equal((await w.fetch(request(1), env)).status, 409)
  assert.equal((await w.fetch(request(11, { protocol: 'HTTP/3' }), env)).status, 200)
})

test('declared oversized and actual over-budget bodies are rejected; the reader is canceled', async () => {
  assert.equal((await worker().fetch(request(1, { length: MAX_BODY + 1 }), env)).status, 413)
  let canceled = 0
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(PLAN[0].wireBytes + 1))
    },
    cancel() {
      canceled++
    },
  })
  const response = await worker().fetch(request(1, { body }), env)
  assert.equal(response.status, 413)
  assert.equal((await response.json()).reason, 'body_size_rejected')
  assert.equal(canceled, 1)
  assert.equal((await worker().fetch(request(1, { bytes: 1 }), env)).status, 400)
})

test('four stalled bodies time out, cancel, and release all four slots without client abort propagation', async () => {
  let canceled = 0
  const w = worker({ bodyTimeoutMs: 5 })
  const stalled = [1, 2, 4, 5].map((slot) =>
    w.fetch(
      request(slot, {
        body: new ReadableStream(
          {
            cancel() {
              canceled++
            },
          },
          { highWaterMark: 0 },
        ),
      }),
      env,
    ),
  )
  const expired = await Promise.all(stalled)
  assert.deepEqual(
    expired.map((r) => r.status),
    [408, 408, 408, 408],
  )
  assert.equal(canceled, 4)
  const next = await Promise.all([6, 7, 8, 9].map((slot) => w.fetch(request(slot), env)))
  assert.deepEqual(
    next.map((r) => r.status),
    [200, 200, 200, 200],
  )
})

test('client abort and throwing logger cannot leak errors or keep the reader open', async () => {
  let canceled = false
  const controller = new AbortController()
  const w = worker({
    log: () => {
      throw Error('private diagnostic failure')
    },
  })
  const response = w.fetch(
    request(1, {
      signal: controller.signal,
      body: new ReadableStream(
        {
          cancel() {
            canceled = true
          },
        },
        { highWaterMark: 0 },
      ),
    }),
    env,
  )
  controller.abort(Error('private cancellation reason'))
  const result = await response
  assert.equal(result.status, 499)
  assert.equal(canceled, true)
  assert.doesNotMatch(await result.text(), /private/)
})

test('configuration only targets the existing worker, defaults disabled, and adds no upstream bindings', () => {
  const base = {
    name: PROBE_WORKER,
    account_id: 'b'.repeat(32),
    workers_dev: true,
    vars: { GATEWAY_ORIGIN: PROBE_ORIGIN },
  }
  const config = probeConfig(base, env.PROBE_RUN_ID)
  assert.equal(config.compatibility_date, '2026-09-17')
  assert.deepEqual(config.compatibility_flags, [])
  assert.deepEqual(config.triggers, { crons: [] })
  assert.deepEqual(Object.keys(config.vars), ['PROBE_RUN_ID', 'PROBE_START_MS', 'PROBE_END_MS'])
  assert.equal(config.vars.PROBE_END_MS, '0')
  assert.throws(() => probeConfig({ ...base, name: 'personal-photos-gateway' }, env.PROBE_RUN_ID))
})
