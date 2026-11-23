import test from 'node:test'
import assert from 'node:assert/strict'
import { headerBudget } from './header-budget.mjs'

test('a fired timeout exhausts the budget even before the clock reaches its deadline', async (t) => {
  t.mock.method(performance, 'now', () => 100)
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    queueMicrotask(callback)
    return 0
  })
  let calls = 0
  const get = headerBudget(
    async (_url, { signal }) => {
      calls++
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      )
    },
    new AbortController().signal,
    30,
  )
  await assert.rejects(get('https://example.test', {}), /deadline/)
  await assert.rejects(get('https://example.test', {}), /deadline/)
  assert.equal(calls, 1)
})
test('a stalled header fetch is bounded and subsequent attempts cannot restart the deadline', async () => {
  let calls = 0
  const get = headerBudget(
    async (_url, { signal }) => {
      calls++
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      )
    },
    new AbortController().signal,
    30,
  )
  await assert.rejects(get('https://example.test', {}), /deadline/)
  await assert.rejects(get('https://example.test', {}), /deadline/)
  assert.equal(calls, 1)
})
test('headers arriving within budget do not abort a later healthy response body', async () => {
  let upstreamSignal
  const get = headerBudget(
    async (_url, { signal }) => {
      upstreamSignal = signal
      return new Response('body')
    },
    new AbortController().signal,
    10,
  )
  const response = await get('https://example.test', {})
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(upstreamSignal.aborted, false)
  assert.equal(await response.text(), 'body')
})
