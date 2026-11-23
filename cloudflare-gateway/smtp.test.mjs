import test from 'node:test'
import assert from 'node:assert/strict'
import { alertAddresses } from './smtp.mjs'

const env = {
  ALERT_SMTP_USERNAME: 'login@example.com',
  ALERT_FROM: 'alerts@example.com',
  ALERT_TO: 'owner@example.com',
}

test('reads the mailbox login, sender and recipient from secrets', () => {
  assert.deepEqual(alertAddresses(env), {
    username: 'login@example.com',
    from: 'alerts@example.com',
    to: 'owner@example.com',
  })
})

test('refuses a missing address or one that could inject a header or command', () => {
  for (const key of Object.keys(env)) {
    assert.throws(() => alertAddresses({ ...env, [key]: undefined }), /Invalid configuration/)
    assert.throws(
      () => alertAddresses({ ...env, [key]: 'owner@example.com\r\nBcc: other@example.com' }),
      /Invalid configuration/,
    )
    assert.throws(
      () => alertAddresses({ ...env, [key]: 'not an address' }),
      /Invalid configuration/,
    )
  }
})
