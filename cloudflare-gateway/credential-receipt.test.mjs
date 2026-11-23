import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { credentialReceipt } from './credential-receipt.mjs'
import { credentialEvent } from './customer-accounts.mjs'
import { credentialLog } from './credential-log.mjs'

const env = {
  CUSTOMER_ACCOUNTS_ENABLED: 'true',
  GATEWAY_ORIGIN: 'https://photos.example.com',
  SNOWFLAKE_ORIGIN: 'https://test.snowflakecomputing.app',
  AUTH0_DOMAIN: 'test.auth0.com',
  AUTH0_EVENT_KEY: '33'.repeat(32),
  GATEWAY_SIGNING_KEY: '22'.repeat(32),
  AUTH0_LOG_STREAM_TOKEN: '44'.repeat(32),
  SNOWFLAKE_PAT: 'test-only',
}
const event = {
  issuer: 'https://test.auth0.com/',
  subject: 'auth0|synthetic-receipt',
  changedAt: Math.floor(Date.now() / 1000) - 60,
}
function actionRequest(signatureOverride) {
  const timestamp = Math.floor(Date.now() / 1000)
  const body = JSON.stringify(event)
  const signature =
    signatureOverride ??
    createHmac('sha256', Buffer.from(env.AUTH0_EVENT_KEY, 'hex'))
      .update(`${timestamp}.${body}`)
      .digest('hex')
  return new Request(env.GATEWAY_ORIGIN + '/auth/credential-change', {
    method: 'POST',
    body,
    headers: { 'x-stillmark-time': String(timestamp), 'x-stillmark-signature': signature },
  })
}
function logRequest(type = 'scp', token = env.AUTH0_LOG_STREAM_TOKEN) {
  return new Request(env.GATEWAY_ORIGIN + '/auth/credential-log', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token },
    body: JSON.stringify([
      {
        log_id: 'synthetic-log-id',
        data: {
          type,
          date: new Date(event.changedAt * 1000).toISOString(),
          user_id: event.subject,
        },
      },
    ]),
  })
}
function outbox(fetch = async () => Response.json({ durable: true }, { status: 202 })) {
  return { idFromName: () => 'fixture', get: () => ({ fetch }) }
}
async function capture(run) {
  const info = console.info
  const fetch = globalThis.fetch
  const records = []
  console.info = (line) => records.push(JSON.parse(line))
  try {
    await run(records)
  } finally {
    console.info = info
    globalThis.fetch = fetch
  }
}
test('receipt is domain-separated HMAC with only allowlisted operational fields', async () =>
  capture(async (records) => {
    await credentialReceipt(event, env, 'action', 'persisted')
    const expected = createHmac('sha256', Buffer.from(env.AUTH0_LOG_STREAM_TOKEN, 'hex'))
      .update('stillmark-credential-receipt-v1\n' + event.issuer + '\n' + event.subject)
      .digest('hex')
    assert.deepEqual(records[0], {
      event: 'stillmark_credential_receipt',
      version: 1,
      source: 'action',
      result: 'persisted',
      changedAt: event.changedAt,
      subjectFingerprint: expected,
    })
    await credentialReceipt(event, env, 'log-stream', 'durable')
    assert.equal(records[1].subjectFingerprint, expected)
    for (const alternate of [
      { ...event, subject: 'auth0|different' },
      { ...event, issuer: 'https://other.auth0.com/' },
    ])
      await credentialReceipt(alternate, env, 'action', 'persisted')
    await credentialReceipt(
      event,
      { ...env, AUTH0_LOG_STREAM_TOKEN: '55'.repeat(32) },
      'action',
      'persisted',
    )
    assert.equal(new Set(records.map((r) => r.subjectFingerprint)).size, 4)
    const serialized = JSON.stringify(records)
    for (const secret of [
      event.subject,
      event.issuer,
      env.AUTH0_LOG_STREAM_TOKEN,
      env.AUTH0_EVENT_KEY,
      env.SNOWFLAKE_PAT,
    ])
      assert.equal(serialized.includes(secret), false)
  }))
test('Action emits persisted receipt only after a successful upstream acknowledgment', async () =>
  capture(async (records) => {
    let finish
    globalThis.fetch = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const pending = credentialEvent(actionRequest(), env)
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal(records.length, 0)
    finish(Response.json({ ok: true }))
    assert.equal((await pending).status, 200)
    assert.equal(records[0].result, 'persisted')
    assert.equal(records[0].source, 'action')
  }))
test('Action fallback emits durable receipt only after retention, and never for failed retention or invalid signatures', async () =>
  capture(async (records) => {
    globalThis.fetch = async () => {
      throw Error('network unavailable')
    }
    let finish
    const pending = credentialEvent(actionRequest(), {
      ...env,
      EMAIL_ALERTS: outbox(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      ),
    })
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal(records.length, 0)
    finish(Response.json({ durable: true }, { status: 202 }))
    assert.equal((await pending).status, 202)
    assert.equal(records[0].result, 'durable')
    assert.equal(records[0].changedAt, event.changedAt)
    records.length = 0
    assert.equal(
      (
        await credentialEvent(actionRequest(), {
          ...env,
          EMAIL_ALERTS: outbox(async () => {
            throw Error('storage unavailable')
          }),
        })
      ).status,
      503,
    )
    assert.equal((await credentialEvent(actionRequest('00'.repeat(32)), env)).status, 401)
    assert.deepEqual(records, [])
  }))
test('log stream receipt proves authenticated scp retention with original cutoff; other events do not emit', async () =>
  capture(async (records) => {
    const configured = { ...env, EMAIL_ALERTS: outbox() }
    const response = await credentialLog(logRequest(), configured)
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { accepted: true })
    assert.equal(records[0].source, 'log-stream')
    assert.equal(records[0].result, 'durable')
    assert.equal(records[0].changedAt, event.changedAt)
    records.length = 0
    assert.equal((await credentialLog(logRequest('scpr'), configured)).status, 202)
    assert.equal((await credentialLog(logRequest('scp', 'wrong'), configured)).status, 401)
    assert.equal(
      (
        await credentialLog(logRequest(), {
          ...env,
          EMAIL_ALERTS: outbox(async () => {
            throw Error('storage unavailable')
          }),
        })
      ).status,
      503,
    )
    assert.deepEqual(records, [])
  }))
test('missing telemetry token and telemetry failure never alter persisted or retained acknowledgment', async () =>
  capture(async (records) => {
    globalThis.fetch = async () => Response.json({ ok: true })
    assert.equal(
      (await credentialEvent(actionRequest(), { ...env, AUTH0_LOG_STREAM_TOKEN: undefined }))
        .status,
      200,
    )
    assert.equal(records.length, 0)
    console.info = () => {
      throw Error('telemetry unavailable')
    }
    assert.equal((await credentialEvent(actionRequest(), env)).status, 200)
    globalThis.fetch = async () => {
      throw Error('upstream unavailable')
    }
    const configured = { ...env, EMAIL_ALERTS: outbox() }
    assert.equal((await credentialEvent(actionRequest(), configured)).status, 202)
    assert.equal((await credentialLog(logRequest(), configured)).status, 202)
  }))
test('hashing failure is observational only and cannot change a persisted acknowledgment', async () =>
  capture(async (records) => {
    const importKey = crypto.subtle.importKey
    globalThis.fetch = async () => Response.json({ ok: true })
    crypto.subtle.importKey = async function (format, key, algorithm, ...rest) {
      if (
        algorithm?.name === 'HMAC' &&
        Buffer.from(key).equals(Buffer.from(env.AUTH0_LOG_STREAM_TOKEN, 'hex'))
      )
        throw Error('telemetry hashing failed')
      return importKey.call(this, format, key, algorithm, ...rest)
    }
    try {
      assert.equal((await credentialEvent(actionRequest(), env)).status, 200)
      assert.deepEqual(records, [])
    } finally {
      crypto.subtle.importKey = importKey
    }
  }))
test('log stream emits no receipt until durable retention acknowledges', async () =>
  capture(async (records) => {
    let finish
    const pending = credentialLog(logRequest(), {
      ...env,
      EMAIL_ALERTS: outbox(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      ),
    })
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal(records.length, 0)
    finish(Response.json({ durable: true }, { status: 202 }))
    assert.equal((await pending).status, 202)
    assert.equal(records.length, 1)
  }))
