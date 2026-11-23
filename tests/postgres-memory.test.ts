import { afterEach, expect, it, vi } from 'vitest'
import { postgresAppMemoryOptions } from '../lib/database/postgres-memory'

afterEach(() => vi.unstubAllEnvs())
it('preserves database defaults unless this process opts into a memory budget', () => {
  vi.stubEnv('PG_APP_WORK_MEM_KB', undefined)
  expect(postgresAppMemoryOptions()).toBeUndefined()
  vi.stubEnv('PG_APP_WORK_MEM_KB', '4096')
  expect(postgresAppMemoryOptions()).toBe('-c work_mem=4096')
})
it.each(['', '-1', '0', '63', '1048577', '4MB', '1.5', '4096 -c row_security=off'])(
  'rejects unsafe or invalid startup options: %s',
  (value) => {
    expect(() => postgresAppMemoryOptions(value)).toThrow('PG_APP_WORK_MEM_KB')
  },
)
