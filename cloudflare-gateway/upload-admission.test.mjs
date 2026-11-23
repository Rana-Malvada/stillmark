import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUploadAdmission } from './upload-admission.mjs'

test('admits many small chunks while bounding total reserved bytes', async () => {
  const acquire = createUploadAdmission({ maxBytes: 24, waitMs: 20 })
  const releases = await Promise.all(Array.from({ length: 12 }, () => acquire(2)))
  assert.ok(releases.every((x) => typeof x === 'function'))
  let admitted = false
  const waiting = acquire(2).then((release) => {
    admitted = true
    return release
  })
  await Promise.resolve()
  assert.equal(admitted, false)
  releases[0]()
  const release = await waiting
  assert.equal(typeof release, 'function')
  releases[0]() // release is idempotent, cannot inflate the available budget.
  assert.equal(await acquire(2), null)
  release()
  releases.forEach((r) => r())
  ;(await acquire(24))()
})

test('bounds waiting, removes canceled waiters, and admits the next waiter', async () => {
  const acquire = createUploadAdmission({ maxBytes: 8, maxWaiting: 1, waitMs: 20 })
  const held = await acquire(8)
  const controller = new AbortController()
  const waiting = acquire(8, controller.signal)
  const rejected = assert.rejects(waiting, { name: 'AbortError' })
  assert.equal(await acquire(1), null)
  controller.abort()
  await rejected
  const next = acquire(8)
  held()
  ;(await next)()
})

test('rejects invalid reservations and bounds admission waiting time', async () => {
  const acquire = createUploadAdmission({ maxBytes: 8, waitMs: 10 })
  for (const bytes of [0, -1, 9, NaN, 1.5]) assert.throws(() => acquire(bytes))
  const held = await acquire(8)
  assert.equal(await acquire(1), null)
  held()
  ;(await acquire(8))()
})
