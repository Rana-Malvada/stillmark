import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { createHmac } from 'node:crypto'
import { credentialReplay } from './replay-credential-change.mjs'

const source = readFileSync(new URL('./credential-change-action.cjs', import.meta.url), 'utf8')
const require = createRequire(import.meta.url)
const key = '39'.repeat(32)
const now = 1794140000
const record = {
  event: 'stillmark_credential_delivery_failed',
  version: 1,
  issuer: 'https://fixture.auth0.invalid/',
  subject: 'auth0|fixture-alice',
  changedAt: now - 120,
  attempts: 3,
}
function action(fetcher) {
  const output = []
  const timeouts = []
  const exported = {}
  let tick = now - 120
  vm.runInNewContext(source, {
    exports: exported,
    require,
    URL,
    Buffer,
    Date: { now: () => tick++ * 1000 },
    AbortSignal: {
      timeout(ms) {
        timeouts.push(ms)
        return AbortSignal.timeout(10)
      },
    },
    fetch: fetcher,
    console: { error: (message) => output.push(JSON.parse(message)) },
  })
  return {
    output,
    timeouts,
    run: () =>
      exported.onExecutePostChangePassword({
        user: { user_id: record.subject, password: 'must-never-log-password' },
        secrets: {
          STILLMARK_ORIGIN: 'https://fixture.example/',
          STILLMARK_ISSUER: record.issuer,
          STILLMARK_EVENT_KEY: key,
          OTHER_TOKEN: 'must-never-log-token',
        },
      }),
  }
}
test('exhausts three bounded attempts and emits one actionable record retaining the original cutoff', async () => {
  const requests = []
  const a = action(async (url, options) => {
    requests.push(new Request(url, options))
    return new Response('private-upstream-body', { status: 503 })
  })
  await assert.rejects(a.run(), /not acknowledged/)
  assert.equal(requests.length, 3)
  assert.deepEqual(a.timeouts, [4000, 4000, 4000])
  assert.deepEqual(a.output, [record])
  const bodies = await Promise.all(requests.map((request) => request.clone().text()))
  assert.equal(new Set(bodies).size, 1)
  const logged = JSON.stringify(a.output)
  for (const secret of [
    key,
    'must-never-log-password',
    'must-never-log-token',
    'private-upstream-body',
    ...requests.map((r) => r.headers.get('x-stillmark-signature')),
  ])
    assert.equal(logged.includes(secret), false)
})
test('handles transport timeout/disconnect and succeeds on a later acknowledgement without a false alarm', async () => {
  let count = 0
  const a = action(async (_url, { signal }) => {
    count++
    if (count === 1) throw new TypeError('connection lost with private detail')
    if (count === 2)
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        setTimeout(() => {}, 15)
      })
    return Response.json({ accepted: true, persisted: true })
  })
  await a.run()
  assert.equal(count, 3)
  assert.deepEqual(a.output, [])
})
test('replay signs a fresh transport timestamp while preserving the original identity/cutoff', async () => {
  const { request, preview } = credentialReplay(record, {
    origin: 'https://fixture.example/',
    issuer: record.issuer,
    key,
    now,
  })
  const body = await request.text()
  assert.equal(JSON.parse(body).changedAt, record.changedAt)
  assert.equal(request.headers.get('x-stillmark-time'), String(now))
  assert.equal(
    request.headers.get('x-stillmark-signature'),
    createHmac('sha256', Buffer.from(key, 'hex')).update(`${now}.${body}`).digest('hex'),
  )
  assert.equal(request.redirect, 'error')
  assert.equal(JSON.stringify(preview).includes(record.subject), false)
  assert.equal(JSON.stringify(preview).includes(key), false)
})
test('dry-run never builds a signed request and malformed/origin-mismatched records fail closed', () => {
  const config = { origin: 'https://fixture.example/', issuer: record.issuer, now }
  assert.equal(credentialReplay(record, config).request, undefined)
  for (const bad of [
    { ...record, changedAt: undefined },
    { ...record, changedAt: now + 6 },
    { ...record, issuer: 'https://other.invalid/' },
    { ...record, secrets: {} },
    { ...record, attempts: 0 },
    { ...record, subject: 'someone' },
  ])
    assert.throws(() => credentialReplay(bad, config))
  for (const origin of [
    'http://fixture.example/',
    'https://fixture.example/path',
    'https://user:pass@fixture.example/',
  ])
    assert.throws(() => credentialReplay(record, { ...config, origin }))
})

for (const status of [200, 202])
  test(`Action only accepts a valid ${status} persistence/durable acknowledgment`, async () => {
    let count = 0
    const valid =
      status === 200 ? { accepted: true, persisted: true } : { accepted: true, durable: true }
    const a = action(async () => {
      count++
      return Response.json(count === 1 ? { accepted: true } : valid, { status })
    })
    await a.run()
    assert.equal(count, 2)
    assert.deepEqual(a.output, [])
  })
