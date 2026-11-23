import { afterEach, expect, it, vi } from 'vitest'
import { postgresPoolMax } from '../lib/database/postgres-pool-budget'

afterEach(() => vi.unstubAllEnvs())
it('preserves defaults and keeps credential pools independently configurable', () => {
  for (const key of ['PG_APP_POOL_MAX', 'PG_MAINTENANCE_POOL_MAX', 'PG_QUEUE_POOL_MAX'])
    vi.stubEnv(key, undefined)
  expect(postgresPoolMax('app')).toBe(10)
  expect(postgresPoolMax('maintenance')).toBe(10)
  expect(postgresPoolMax('queue')).toBe(2)
  vi.stubEnv('PG_APP_POOL_MAX', '3')
  expect(postgresPoolMax('app')).toBe(3)
  expect(postgresPoolMax('maintenance')).toBe(10)
  vi.stubEnv('PG_QUEUE_POOL_MAX', '1')
  expect(postgresPoolMax('queue')).toBe(1)
})
it('rejects invalid limits instead of silently opening excessive connections', () => {
  for (const value of ['', '0', '-1', '1.5', '101', 'NaN', '3x']) {
    vi.stubEnv('PG_APP_POOL_MAX', value)
    expect(() => postgresPoolMax('app')).toThrow('PG_APP_POOL_MAX')
  }
})

it('budgets every credential pool and rollout process before opening a pool', () => {
  vi.stubEnv('PG_APP_POOL_MAX', '10')
  vi.stubEnv('PG_MAINTENANCE_POOL_MAX', '10')
  vi.stubEnv('PG_QUEUE_POOL_MAX', '2')
  vi.stubEnv('PG_INDEPENDENT_POOL_MAX', '2')
  vi.stubEnv('PG_FLEET_CONNECTION_BUDGET', '100')
  vi.stubEnv('PG_FLEET_APP_PROCESSES', '2')
  vi.stubEnv('PG_FLEET_UPLOAD_PROCESSES', '1')
  vi.stubEnv('PG_FLEET_OTHER_CONNECTIONS', '10')
  expect(postgresPoolMax('app')).toBe(10)
  vi.stubEnv('PG_FLEET_APP_PROCESSES', '3')
  expect(() => postgresPoolMax('app')).toThrow('130 requested')
  vi.stubEnv('PG_FLEET_OTHER_CONNECTIONS', undefined)
  expect(() => postgresPoolMax('queue')).toThrow('All PG_FLEET')
})

it('can require a complete fleet budget before opening any connection pool', () => {
  vi.stubEnv('PG_FLEET_BUDGET_REQUIRED', 'true')
  for (const key of [
    'PG_FLEET_CONNECTION_BUDGET',
    'PG_FLEET_APP_PROCESSES',
    'PG_FLEET_UPLOAD_PROCESSES',
    'PG_FLEET_OTHER_CONNECTIONS',
  ])
    vi.stubEnv(key, undefined)
  expect(() => postgresPoolMax('app')).toThrow('All PG_FLEET')
})
