import { afterEach, expect, it, vi } from 'vitest'
import {
  runSearchWork,
  SearchAdmission,
  searchAdmissionLimits,
} from '@/lib/search/search-admission'
import {
  databaseContext,
  type DatabaseIdentity,
  databaseSignal,
} from '@/lib/database/database-context'
import { apiError } from '@/lib/http'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
const limits = () => ({
  active: 2,
  perUser: 1,
  queued: 2,
  queuedPerUser: 1,
  subscribers: 16,
  subscribersPerUser: 8,
  timeoutMs: 1000,
})
const tick = () => vi.advanceTimersByTimeAsync(0)

it('bounds total and per-user work, returns retryable overload, and avoids queue head blocking', async () => {
  vi.useFakeTimers()
  const admission = new SearchAdmission(limits)
  const finish = new Map<string, () => void>()
  let active = 0
  let peak = 0
  const work = (name: string) => async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise<void>((resolve) => finish.set(name, resolve))
    active--
    return name
  }
  const a = admission.run('alice', '1', work('a'))
  const a2 = admission.run('alice', '2', work('a2'))
  const b = admission.run('bob', '1', work('b'))
  const c = admission.run('carol', '1', work('c'))
  const overloaded = await admission.run('dave', '1', work('d')).catch((error) => error)
  const response = apiError(overloaded)
  expect(response.status).toBe(503)
  expect(response.headers.get('retry-after')).toBe('1')
  await tick()
  expect([...finish.keys()]).toEqual(['a', 'b'])
  finish.get('b')!()
  await tick()
  expect([...finish.keys()]).toEqual(['a', 'b', 'c'])
  finish.get('a')!()
  await tick()
  expect(finish.has('a2')).toBe(true)
  finish.get('a2')!()
  finish.get('c')!()
  expect(await Promise.all([a, a2, b, c])).toEqual(['a', 'a2', 'b', 'c'])
  expect(peak).toBe(2)
})

it('counts queue waiting toward the deadline and retains active slots until transport settles', async () => {
  vi.useFakeTimers()
  const admission = new SearchAdmission(() => ({ ...limits(), active: 1, timeoutMs: 100 }))
  let finish!: () => void
  const first = Promise.allSettled([
    admission.run(
      'alice',
      '1',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    ),
  ])
  await vi.advanceTimersByTimeAsync(20)
  const queuedWork = vi.fn(async () => 'queued')
  const queued = Promise.allSettled([admission.run('bob', '1', queuedWork)])
  await vi.advanceTimersByTimeAsync(100)
  expect((await first)[0]).toMatchObject({ status: 'rejected', reason: { status: 504 } })
  expect((await queued)[0]).toMatchObject({ status: 'rejected', reason: { status: 504 } })
  expect(queuedWork).not.toHaveBeenCalled()
  finish()
  await tick()
  await expect(admission.run('bob', '2', async () => 'recovered')).resolves.toBe('recovered')
})

it('bounds duplicate subscribers and cancels queued work without running it', async () => {
  vi.useFakeTimers()
  const admission = new SearchAdmission(() => ({ ...limits(), active: 1, subscribersPerUser: 2 }))
  let finish!: () => void
  const first = admission.run(
    'alice',
    '1',
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const duplicate = admission.run('alice', '1', async () => {
    throw Error('must coalesce')
  })
  await expect(admission.run('alice', '1', async () => {})).rejects.toMatchObject({
    status: 503,
    retryAfterSeconds: 1,
  })
  const controller = new AbortController()
  const queuedWork = vi.fn(async () => {})
  const queued = Promise.allSettled([admission.run('bob', '1', queuedWork, controller.signal)])
  controller.abort()
  expect((await queued)[0].status).toBe('rejected')
  await tick()
  finish()
  await Promise.all([first, duplicate])
  expect(queuedWork).not.toHaveBeenCalled()
})

it('copies verified identity without request bindings/caches and keeps subscriber aborts independent', async () => {
  const identity: DatabaseIdentity = {
    username: 'alice',
    mainAdmin: false,
    adminRead: false,
    adminWrite: false,
    canWrite: true,
    accessManager: false,
  }
  let finish!: () => void
  let operationSignal: AbortSignal | undefined
  const work = vi.fn(async () => {
    const context = databaseContext.getStore()
    expect(context?.kind).toBe('request')
    expect(context).not.toHaveProperty('requestBinding')
    expect(context).not.toHaveProperty('caller')
    operationSignal = databaseSignal()
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return context?.kind === 'request' ? await context.identity : null
  })
  const a = new AbortController()
  const b = new AbortController()
  const first = databaseContext.run(
    { kind: 'request', signal: a.signal, requestBinding: { method: 'GET', target: '/private' } },
    () => runSearchWork(identity, 'identity-copy', work),
  )
  const second = databaseContext.run({ kind: 'request', signal: b.signal }, () =>
    runSearchWork(identity, 'identity-copy', work),
  )
  const settled = Promise.allSettled([first, second])
  await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(1))
  a.abort()
  expect(operationSignal?.aborted).toBe(false)
  identity.mainAdmin = true
  finish()
  const results = await settled
  expect(results[0].status).toBe('rejected')
  expect(results[1]).toMatchObject({ status: 'fulfilled', value: { mainAdmin: false } })
})

it('cancels active shared work when every subscriber leaves and recovers', async () => {
  const admission = new SearchAdmission(limits)
  const a = new AbortController()
  const b = new AbortController()
  let activeSignal: AbortSignal | undefined
  const work = vi.fn((signal: AbortSignal) => {
    activeSignal = signal
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    )
  })
  const settled = Promise.allSettled([
    admission.run('alice', '1', work, a.signal),
    admission.run('alice', '1', work, b.signal),
  ])
  await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(1))
  a.abort()
  b.abort()
  expect(activeSignal?.aborted).toBe(true)
  expect((await settled).every((result) => result.status === 'rejected')).toBe(true)
  await expect(admission.run('alice', '1', async () => 'recovered')).resolves.toBe('recovered')
})

it('rejects malformed budgets and per-user budgets larger than the shared budget', () => {
  expect(searchAdmissionLimits()).toMatchObject({
    active: 4,
    perUser: 1,
    queued: 32,
    queuedPerUser: 2,
    timeoutMs: 30000,
  })
  for (const [name, value] of [
    ['SEARCH_MAX_ACTIVE', '0'],
    ['SEARCH_MAX_ACTIVE_PER_USER', '5'],
    ['SEARCH_REQUEST_TIMEOUT_MS', '99'],
    ['SEARCH_MAX_QUEUED', '-1'],
    ['SEARCH_MAX_SUBSCRIBERS', '1.5'],
  ]) {
    vi.stubEnv(name, value)
    expect(searchAdmissionLimits).toThrow(name)
    vi.unstubAllEnvs()
  }
})
