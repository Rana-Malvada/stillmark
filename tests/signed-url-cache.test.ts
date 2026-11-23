import { afterEach, expect, it, vi } from 'vitest'
import { SignedUrlCache } from '../lib/signed-url-cache'
import {
  signedUrlCacheConfig,
  snowflakeStoragePoolConfig,
} from '../lib/snowflake/snowflake-capacity'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
it('retains more than 500 URLs and evicts least recently used entries at capacity', () => {
  const cache = new SignedUrlCache(1000, 1024 * 1024)
  const exp = Date.now() + 60000
  for (let i = 0; i < 1000; i++) cache.set(String(i), 'https://example.test/' + i, exp)
  expect(cache.get('0')).toBe('https://example.test/0')
  expect(cache.set('new', 'https://example.test/new', exp)).toBe(1)
  expect(cache.get('1')).toBeUndefined()
  expect(cache.get('0')).toBeDefined()
  expect(cache.size).toBe(1000)
})
it('expires URLs and reclaims their byte budget', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const cache = new SignedUrlCache(10, 1000)
  cache.set('key', 'https://example.test', 2000)
  expect(cache.bytes).toBeGreaterThan(0)
  vi.setSystemTime(2000)
  expect(cache.get('key')).toBeUndefined()
  expect(cache.bytes).toBe(0)
})
it('enforces byte budgets and refuses oversized or expired entries', () => {
  const cache = new SignedUrlCache(100, 300)
  const expires = Date.now() + 60000
  cache.set('a', 'https://a', expires)
  cache.set('b', 'https://b', expires)
  cache.set('c', 'https://c', expires)
  expect(cache.bytes).toBeLessThanOrEqual(300)
  expect(cache.get('a')).toBeUndefined()
  cache.set('huge', 'x'.repeat(400), expires)
  cache.set('old', 'url', Date.now() - 1)
  expect(cache.get('huge')).toBeUndefined()
  expect(cache.get('old')).toBeUndefined()
  for (const k of cache.keys()) cache.delete(k)
  expect(cache.bytes).toBe(0)
})
it('separates bounded storage sizing from other Snowflake pools', () => {
  vi.stubEnv('SF_POOL_MAX', '3')
  vi.stubEnv('SF_STORAGE_POOL_MAX', '12')
  expect(snowflakeStoragePoolConfig()).toEqual({
    min: 0,
    max: 12,
    acquireTimeoutMillis: 10000,
    maxWaitingClients: 128,
  })
  vi.stubEnv('SF_STORAGE_POOL_MAX', '101')
  expect(snowflakeStoragePoolConfig).toThrow('SF_STORAGE_POOL_MAX')
  vi.stubEnv('MEDIA_URL_CACHE_MAX_ENTRIES', '0')
  expect(signedUrlCacheConfig).toThrow('MEDIA_URL_CACHE_MAX_ENTRIES')
})
