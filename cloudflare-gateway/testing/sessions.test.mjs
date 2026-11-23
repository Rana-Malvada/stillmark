import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jwtDecrypt } from 'jose'
import { testSessions } from './sessions.mjs'

test('issues ordinary encrypted session fixtures with independent sessions and finite lifetime', async () => {
  const key = 'ab'.repeat(32)
  const now = Math.floor(Date.now() / 1000)
  const rows = await testSessions(
    'STILLMARK_LOADTEST_TEST',
    ['STILLMARK_LOADTEST_TEST_U1', 'STILLMARK_LOADTEST_TEST_U2'],
    key,
    now,
  )
  assert.notEqual(rows[0].sid, rows[1].sid)
  const { payload } = await jwtDecrypt(rows[0].cookie.split('=')[1], Buffer.from(key, 'hex'), {
    subject: 'gallery-session',
  })
  assert.equal(payload.auth0Subject, rows[0].subject)
  assert.equal(payload.revocationBackend, 'postgres')
  assert.equal(payload.exp, now + 3600)
  assert.equal(payload.absoluteExpiresAt, payload.exp)
  await assert.rejects(
    jwtDecrypt(rows[0].cookie.split('=')[1], Buffer.from('cd'.repeat(32), 'hex')),
  )
})
test('rejects non-test identities, duplicate fixtures and invalid keys', async () => {
  for (const args of [
    ['PRODUCTION', ['EXAMPLEADMIN'], 'ab'.repeat(32)],
    ['STILLMARK_LOADTEST_TEST', ['EXAMPLEADMIN'], 'ab'.repeat(32)],
    ['STILLMARK_LOADTEST_TEST', ['STILLMARK_LOADTEST_TEST_U1'], 'bad'],
    [
      'STILLMARK_LOADTEST_TEST',
      ['STILLMARK_LOADTEST_TEST_U1', 'STILLMARK_LOADTEST_TEST_U1'],
      'ab'.repeat(32),
    ],
  ])
    await assert.rejects(testSessions(...args))
})
