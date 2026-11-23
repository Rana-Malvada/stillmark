import { afterEach, expect, it, vi } from 'vitest'
import { CallerPoolCache } from '@/lib/caller-pool-cache'
import { createPool } from 'generic-pool'
import { retireConnectionPool } from '@/lib/pool-retirement'

afterEach(() => vi.useRealTimers())

it('isolates tokens, reuses an exact token, and retires idle pools after inactivity', () => {
  vi.useFakeTimers()
  const retire = vi.fn()
  const cache = new CallerPoolCache(retire, 100)
  const a = { borrowed: 0, pending: 0 }
  const b = { borrowed: 0, pending: 0 }
  expect(cache.getOrCreate('token-a', () => a)).toBe(a)
  expect(cache.getOrCreate('token-b', () => b)).toBe(b)
  vi.advanceTimersByTime(60)
  expect(
    cache.getOrCreate('token-a', () => {
      throw new Error('must reuse')
    }),
  ).toBe(a)
  vi.advanceTimersByTime(40)
  expect(retire).toHaveBeenCalledExactlyOnceWith(b)
  expect(cache.has('token-a')).toBe(true)
  vi.advanceTimersByTime(100)
  expect(retire).toHaveBeenCalledTimes(2)
  expect(cache.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds idle retention without evicting borrowed or waiting work', () => {
  vi.useFakeTimers()
  const retire = vi.fn()
  const cache = new CallerPoolCache(retire, 100, 1)
  const busy = { borrowed: 1, pending: 0 }
  const waiting = { borrowed: 0, pending: 1 }
  const idle = { borrowed: 0, pending: 0 }
  cache.getOrCreate('busy', () => busy)
  cache.getOrCreate('waiting', () => waiting)
  cache.getOrCreate('idle', () => idle)
  cache.getOrCreate('next', () => ({ borrowed: 0, pending: 0 }))
  cache.getOrCreate('newest', () => ({ borrowed: 0, pending: 0 }))
  expect(retire).toHaveBeenCalledExactlyOnceWith(idle)
  vi.advanceTimersByTime(100)
  expect(cache.size).toBe(2)
  expect(retire).not.toHaveBeenCalledWith(busy)
  expect(retire).not.toHaveBeenCalledWith(waiting)
  busy.borrowed = 0
  waiting.pending = 0
  vi.advanceTimersByTime(100)
  expect(cache.size).toBe(0)
})

it('clear cancels cleanup and does not retire pools twice during explicit shutdown', () => {
  vi.useFakeTimers()
  const retire = vi.fn()
  const cache = new CallerPoolCache(retire, 100)
  const pool = { borrowed: 0, pending: 0 }
  cache.getOrCreate('a', () => pool)
  expect([...cache.values()]).toEqual([pool])
  cache.clear()
  vi.advanceTimersByTime(200)
  expect(retire).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('destroys a real idle connection while letting borrowed work finish', async () => {
  vi.useFakeTimers()
  const destroyed = vi.fn(async () => {})
  const pool = createPool({ create: async () => ({}), destroy: destroyed }, { min: 0, max: 1 })
  const retirements: Promise<void>[] = []
  const cache = new CallerPoolCache<typeof pool>((p) => {
    retirements.push(retireConnectionPool(p))
  }, 100)
  cache.getOrCreate('a', () => pool)
  const connection = await pool.acquire()
  await vi.advanceTimersByTimeAsync(200)
  expect(cache.size).toBe(1)
  expect(destroyed).not.toHaveBeenCalled()
  await pool.release(connection)
  await vi.advanceTimersByTimeAsync(100)
  await Promise.all(retirements)
  expect(destroyed).toHaveBeenCalledExactlyOnceWith(connection)
  expect(pool.size).toBe(0)
})
