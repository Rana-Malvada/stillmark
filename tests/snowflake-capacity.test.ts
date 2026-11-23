import { afterEach, expect, it, vi } from 'vitest'
import {
  snowflakeCallerRetention,
  snowflakePoolConfig,
  snowflakeStoragePoolConfig,
} from '../lib/snowflake/snowflake-capacity'

afterEach(() => vi.unstubAllEnvs())
it('keeps lazy pools and existing defaults while allowing deployment-specific limits', () => {
  for (const key of ['SF_POOL_MAX', 'SF_CALLER_POOL_IDLE_MS', 'SF_CALLER_POOL_MAX_IDLE'])
    vi.stubEnv(key, undefined)
  expect(snowflakePoolConfig()).toEqual({ min: 0, max: 10 })
  expect(snowflakeCallerRetention()).toEqual({ idleMs: 120000, maxIdle: 512 })
  vi.stubEnv('SF_POOL_MAX', '3')
  vi.stubEnv('SF_CALLER_POOL_IDLE_MS', '30000')
  vi.stubEnv('SF_CALLER_POOL_MAX_IDLE', '64')
  expect(snowflakePoolConfig()).toEqual({ min: 0, max: 3 })
  expect(snowflakeCallerRetention()).toEqual({ idleMs: 30000, maxIdle: 64 })
})
it('bounds storage acquisition time and the pool waiting queue', () => {
  vi.stubEnv('SF_STORAGE_CHECKOUT_TIMEOUT_MS', '750')
  vi.stubEnv('SF_STORAGE_MAX_PENDING_CHECKOUTS', '8')
  expect(snowflakeStoragePoolConfig()).toMatchObject({
    acquireTimeoutMillis: 750,
    maxWaitingClients: 8,
  })
  for (const [key, value] of [
    ['SF_STORAGE_CHECKOUT_TIMEOUT_MS', '0'],
    ['SF_STORAGE_CHECKOUT_TIMEOUT_MS', '120001'],
    ['SF_STORAGE_MAX_PENDING_CHECKOUTS', '0'],
    ['SF_STORAGE_MAX_PENDING_CHECKOUTS', '4097'],
  ]) {
    vi.stubEnv('SF_STORAGE_CHECKOUT_TIMEOUT_MS', '750')
    vi.stubEnv('SF_STORAGE_MAX_PENDING_CHECKOUTS', '8')
    vi.stubEnv(key, value)
    expect(snowflakeStoragePoolConfig).toThrow(key)
  }
})
it('rejects invalid or unsafe capacity settings', () => {
  for (const value of ['', '0', '-2', '1.5', '101', 'ten']) {
    vi.stubEnv('SF_POOL_MAX', value)
    expect(snowflakePoolConfig).toThrow('SF_POOL_MAX')
  }
  vi.stubEnv('SF_CALLER_POOL_IDLE_MS', '3600001')
  expect(snowflakeCallerRetention).toThrow('SF_CALLER_POOL_IDLE_MS')
})
