import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const read = vi.hoisted(() => vi.fn())
vi.mock('../lib/identity/identity-control', () => ({ identityControl: read }))
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(100000)
  read.mockReset().mockResolvedValue([])
})
afterEach(() => vi.useRealTimers())
it('reuses user reads across a shared-graph refresh without extending their expiry', async () => {
  const { gatewayUserMetadata: get } = await import('../lib/identity/gateway-user-metadata')
  const a = await get('USER_A', 'USER_A:1')
  vi.advanceTimersByTime(10000)
  const b = await get('USER_B', 'USER_B:1')
  vi.advanceTimersByTime(5001) // A and the earlier shared graph expire; B does not.
  await get('USER_A', 'USER_A:1')
  expect((await get('USER_B', 'USER_B:1')).expires).toBe(b.expires)
  expect(read).toHaveBeenCalledTimes(6)
  expect(a.expires).toBe(115000)
  vi.advanceTimersByTime(10000)
  await get('USER_B', 'USER_B:1')
  expect(read).toHaveBeenCalledTimes(8)
})
it('coalesces concurrent reads but bypasses on fresh administration or a new epoch', async () => {
  const { gatewayUserMetadata: get } = await import('../lib/identity/gateway-user-metadata')
  await Promise.all(Array.from({ length: 20 }, () => get('USER_A', 'USER_A:1')))
  expect(read).toHaveBeenCalledTimes(2)
  await get('USER_A')
  await get('USER_A', 'USER_A:2')
  expect(read).toHaveBeenCalledTimes(6)
})
it('does not retain rejected lookups', async () => {
  const { gatewayUserMetadata: get } = await import('../lib/identity/gateway-user-metadata')
  read.mockRejectedValueOnce(Error('unavailable'))
  await expect(get('USER_A', 'USER_A:1')).rejects.toThrow('unavailable')
  await get('USER_A', 'USER_A:1')
  expect(read).toHaveBeenCalledTimes(4)
})

it('refreshes active users early without blocking a still-valid snapshot', async () => {
  const { gatewayUserMetadata: get, refreshGatewayUserMetadata: refresh } =
    await import('../lib/identity/gateway-user-metadata')
  const first = await get('USER_A', 'USER_A:1')
  const refreshStarted = first.refreshAfter
  vi.setSystemTime(refreshStarted)
  let release!: () => void
  read.mockImplementation(
    () =>
      new Promise<[]>((resolve) => {
        release = () => resolve([])
      }),
  )
  // Use a shared deferred promise for both metadata statements.
  const work = new Promise<[]>((resolve) => {
    release = () => resolve([])
  })
  read.mockImplementation(() => work)
  refresh('USER_A', 'USER_A:1')
  refresh('USER_A', 'USER_A:1')
  expect(read).toHaveBeenCalledTimes(4)
  expect((await get('USER_A', 'USER_A:1')).expires).toBe(first.expires)
  release()
  await vi.advanceTimersByTimeAsync(0)
  expect((await get('USER_A', 'USER_A:1')).expires).toBe(refreshStarted + 15000)
})
it('failed prefetch cannot extend expiry or allow expired authorization', async () => {
  const { gatewayUserMetadata: get, refreshGatewayUserMetadata: refresh } =
    await import('../lib/identity/gateway-user-metadata')
  const first = await get('USER_A', 'USER_A:1')
  vi.setSystemTime(first.refreshAfter)
  read.mockRejectedValue(Error('unavailable'))
  refresh('USER_A', 'USER_A:1')
  await vi.advanceTimersByTimeAsync(0)
  expect((await get('USER_A', 'USER_A:1')).expires).toBe(first.expires)
  vi.setSystemTime(first.expires)
  await expect(get('USER_A', 'USER_A:1')).rejects.toThrow('unavailable')
})
it('bounds concurrent background refresh and performs no timer-driven idle work', async () => {
  vi.stubEnv('GATEWAY_ROLE_REFRESH_MAX', '2')
  try {
    const { gatewayUserMetadata: get, refreshGatewayUserMetadata: refresh } =
      await import('../lib/identity/gateway-user-metadata')
    for (let i = 0; i < 5; i++) await get('USER_' + i, 'KEY_' + i)
    read.mockClear()
    vi.advanceTimersByTime(12000)
    expect(read).not.toHaveBeenCalled()
    let release!: () => void
    const work = new Promise<[]>((resolve) => {
      release = () => resolve([])
    })
    read.mockImplementation(() => work)
    for (let i = 0; i < 5; i++) refresh('USER_' + i, 'KEY_' + i)
    expect(read).toHaveBeenCalledTimes(4)
    release()
    await vi.advanceTimersByTimeAsync(0)
  } finally {
    vi.unstubAllEnvs()
  }
})
it('waits for an in-flight refresh after hard expiry, then retains its original deadline', async () => {
  const { gatewayUserMetadata: get, refreshGatewayUserMetadata: refresh } =
    await import('../lib/identity/gateway-user-metadata')
  const first = await get('USER_A', 'USER_A:1')
  const started = first.refreshAfter
  vi.setSystemTime(started)
  let release!: () => void
  const deferred = new Promise<[]>((resolve) => {
    release = () => resolve([])
  })
  read.mockImplementation(() => deferred)
  refresh('USER_A', 'USER_A:1')
  vi.setSystemTime(first.expires + 1)
  let settled = false
  const waiting = get('USER_A', 'USER_A:1').then((x) => {
    settled = true
    return x
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  release()
  expect((await waiting).expires).toBe(started + 15000)
  const calls = read.mock.calls.length
  await get('USER_A', 'USER_A:1')
  expect(read).toHaveBeenCalledTimes(calls)
})
