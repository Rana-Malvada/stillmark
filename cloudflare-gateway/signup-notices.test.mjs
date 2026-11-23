import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  notifySignups,
  SIGNUP_NOTICES_PER_CHECK,
  signupMessage,
  signupPlan,
  signupRecords,
} from './signup-notices.mjs'

const HOUR = 3600000
const start = Date.parse('2026-11-22T12:00:00Z')
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const signup = (n, at, displayName = 'Member ' + n) => ({
  id: id(n),
  createdAt: new Date(at).toISOString(),
  displayName,
})
function memory() {
  const values = new Map()
  return {
    values,
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
  }
}
function mailbox(results = []) {
  const sent = []
  const deliver = async (subject, body) => {
    sent.push({ subject, body })
    return results.length ? results.shift() : { accepted: true }
  }
  return { sent, deliver }
}
const quiet = async (work) => {
  const original = console.info
  console.info = () => {}
  try {
    return await work()
  } finally {
    console.info = original
  }
}

test('accounts that already existed when notices began are never reported', async () => {
  const storage = memory()
  const mail = mailbox()
  const existing = [signup(1, start - 10 * HOUR), signup(2, start - 1000)]
  assert.equal(
    await quiet(() => notifySignups(storage, existing, start, 'https://x', mail.deliver)),
    0,
  )
  assert.equal(
    await quiet(() => notifySignups(storage, existing, start + HOUR, 'https://x', mail.deliver)),
    0,
  )
  assert.deepEqual(mail.sent, [])
  assert.equal(storage.values.get('signups').since, start)
})

test('each new account is reported exactly once, oldest first', async () => {
  const storage = memory()
  const mail = mailbox()
  await quiet(() => notifySignups(storage, [], start, 'https://x', mail.deliver))
  const list = [signup(2, start + 2000), signup(1, start + 1000)]
  assert.equal(
    await quiet(() => notifySignups(storage, list, start + 5000, 'https://x', mail.deliver)),
    2,
  )
  assert.equal(
    await quiet(() => notifySignups(storage, list, start + 300000, 'https://x', mail.deliver)),
    0,
  )
  list.push(signup(3, start + 400000))
  assert.equal(
    await quiet(() => notifySignups(storage, list, start + 600000, 'https://x', mail.deliver)),
    1,
  )
  assert.deepEqual(
    mail.sent.map((m) => m.body.match(/Display name: (.*)/)[1]),
    ['Member 1', 'Member 2', 'Member 3'],
  )
  assert.ok(mail.sent.every((m) => m.subject === 'New account created'))
})

test('a failed send is retried on the next check without repeating delivered notices', async () => {
  const storage = memory()
  const mail = mailbox([{ accepted: true }, { accepted: false, stage: 'authenticate' }])
  await quiet(() => notifySignups(storage, [], start, 'https://x', mail.deliver))
  const list = [signup(1, start + 1), signup(2, start + 2), signup(3, start + 3)]
  assert.equal(
    await quiet(() => notifySignups(storage, list, start + 10, 'https://x', mail.deliver)),
    1,
  )
  // The second failed, so the third was not attempted in that check.
  assert.equal(mail.sent.length, 2)
  assert.equal(
    await quiet(() => notifySignups(storage, list, start + 300000, 'https://x', mail.deliver)),
    2,
  )
  assert.deepEqual(
    mail.sent.map((m) => m.body.match(/Display name: (.*)/)[1]),
    ['Member 1', 'Member 2', 'Member 2', 'Member 3'],
  )
})

test('a thrown mailer is a failed send, and an unavailable monitor list sends nothing', async () => {
  const storage = memory()
  await quiet(() =>
    notifySignups(storage, undefined, start, 'https://x', async () => ({ accepted: true })),
  )
  assert.equal(storage.values.get('signups').since, start)
  const list = [signup(1, start + 1)]
  assert.equal(
    await quiet(() =>
      notifySignups(storage, list, start + 10, 'https://x', async () => {
        throw Error('socket')
      }),
    ),
    0,
  )
  assert.deepEqual(storage.values.get('signups').seen, {})
  for (const unavailable of [undefined, null, 'x', {}])
    assert.equal(
      await quiet(() =>
        notifySignups(storage, unavailable, start + 20, 'https://x', async () => assert.fail()),
      ),
      0,
    )
})

test('a burst is spread over checks and reported markers are forgotten after the window', async () => {
  const storage = memory()
  const mail = mailbox()
  await quiet(() => notifySignups(storage, [], start, 'https://x', mail.deliver))
  const list = Array.from({ length: 7 }, (_, i) => signup(i + 1, start + i + 1))
  const counts = []
  for (let check = 1; check <= 4; check++)
    counts.push(
      await quiet(() =>
        notifySignups(storage, list, start + check * 300000, 'https://x', mail.deliver),
      ),
    )
  assert.deepEqual(counts, [SIGNUP_NOTICES_PER_CHECK, SIGNUP_NOTICES_PER_CHECK, 1, 0])
  assert.equal(Object.keys(storage.values.get('signups').seen).length, 7)
  // Past the window the markers are pruned, and the same stale records are still not re-sent.
  assert.equal(
    await quiet(() => notifySignups(storage, list, start + 73 * HOUR, 'https://x', mail.deliver)),
    0,
  )
  assert.deepEqual(storage.values.get('signups').seen, {})
  assert.equal(mail.sent.length, 7)
})

test('malformed records are ignored and member-supplied names cannot shape the message', () => {
  assert.equal(signupRecords('nope'), null)
  const records = signupRecords([
    null,
    { id: 'not-a-uuid', createdAt: new Date(start).toISOString(), displayName: 'x' },
    { id: id(1), createdAt: 'not a date', displayName: 'x' },
    { id: id(2), createdAt: new Date(start).toISOString(), displayName: 7 },
    signup(3, start, 'Eve\r\n.\r\nSubject: forged\u0000‮' + 'x'.repeat(300)),
    signup(4, start - 1, '   '),
  ])
  assert.deepEqual(
    records.map((r) => r.id),
    [id(4), id(3)],
  )
  assert.equal(records[0].displayName, 'Member')
  assert.equal(records[1].displayName.length, 120)
  assert.doesNotMatch(records[1].displayName, /[\r\n\u0000‮]/)
  const { subject, body } = signupMessage(records[1], 'https://photos.example')
  assert.equal(subject, 'New account created')
  assert.equal(body.split('\n').filter((line) => line.startsWith('Display name: ')).length, 1)
  assert.match(body, /Open https:\/\/photos\.example\/ and choose Admin/)
  assert.doesNotMatch(body, /@/)
})

test('corrupt stored state restarts from now instead of reporting old accounts', () => {
  const plan = signupPlan(
    { since: 'bad', seen: null },
    [{ id: id(1), createdAt: start - 1, displayName: 'A' }],
    start,
  )
  assert.equal(plan.state.since, start)
  assert.deepEqual(plan.due, [])
})
