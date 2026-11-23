import { afterEach, expect, it, vi } from 'vitest'

const read = vi.hoisted(() => vi.fn())
vi.mock('../lib/identity/identity-control', () => ({ identityControl: read }))
import { gatewayRoleMetadata } from '../lib/identity/gateway-role-metadata'

afterEach(() => {
  vi.useRealTimers()
  read.mockReset()
})
it('coalesces shared graphs and does not extend expiry when reused', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(100000)
  read.mockResolvedValue([{ name: 'VIEWER' }])
  const results = await Promise.all(
    Array.from({ length: 250 }, () => gatewayRoleMetadata('SHARED', false)),
  )
  expect(read).toHaveBeenCalledTimes(1)
  expect(results.every((r) => r.expires === 115000)).toBe(true)
  vi.advanceTimersByTime(14000)
  expect((await gatewayRoleMetadata('SHARED', false)).expires).toBe(115000)
  await gatewayRoleMetadata('SHARED', true)
  expect(read).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(1001)
  await gatewayRoleMetadata('SHARED', false)
  expect(read).toHaveBeenCalledTimes(3)
})
it('does not cache failed lookups or share distinct roles', async () => {
  read.mockRejectedValueOnce(Error('unavailable')).mockResolvedValue([])
  await expect(gatewayRoleMetadata('FAILED', false)).rejects.toThrow('unavailable')
  await gatewayRoleMetadata('FAILED', false)
  await gatewayRoleMetadata('OTHER', false)
  expect(read).toHaveBeenCalledTimes(3)
})
