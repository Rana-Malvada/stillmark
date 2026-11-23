import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
}))
vi.mock('pg', () => ({
  default: {
    Pool: class {
      on() {}
      async end() {}
      async connect() {
        return { query: state.query, release: state.release }
      }
    },
  },
}))
import { closePool, pgAuthEpoch, pgAuthMainAdmin } from '@/lib/postgres'
import { withDatabaseRequest } from '@/lib/database/database-context'

afterEach(async () => {
  await closePool()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})
function setup() {
  vi.stubEnv('PG_HOST', 'test')
  vi.stubEnv('PG_USER', 'personal_photos_app')
  vi.stubEnv('PG_SSL', 'false')
  state.query.mockResolvedValue({ rows: [{ epoch: '1', allowed: true }] })
}
it('shares bootstrap facts only for the same caller in the same request', async () => {
  setup()
  await withDatabaseRequest(async () => {
    expect(await pgAuthEpoch('ALICE')).toBe('1')
    expect(await pgAuthMainAdmin('ALICE')).toBe(true)
    expect(state.query).toHaveBeenCalledTimes(1)
    await pgAuthMainAdmin('BOB')
    expect(state.query).toHaveBeenCalledTimes(2)
    expect(state.query.mock.calls[0][1]).toEqual(['ALICE'])
  })()
  await withDatabaseRequest(() => pgAuthMainAdmin('ALICE'))()
  expect(state.query).toHaveBeenCalledTimes(3)
})
it('fresh bootstrap replaces grants and failed refresh cannot retain a grant', async () => {
  setup()
  await withDatabaseRequest(async () => {
    await pgAuthEpoch('ALICE')
    state.query.mockResolvedValueOnce({ rows: [{ epoch: '2', allowed: false }] })
    expect(await pgAuthEpoch('ALICE')).toBe('2')
    expect(await pgAuthMainAdmin('ALICE')).toBe(false)
    state.query.mockRejectedValueOnce(new Error('unavailable'))
    await expect(pgAuthEpoch('ALICE')).rejects.toThrow('unavailable')
    state.query.mockResolvedValueOnce({ rows: [{ allowed: false }] })
    expect(await pgAuthMainAdmin('ALICE')).toBe(false)
    expect(state.query).toHaveBeenCalledTimes(4)
  })()
})
it('does not reuse bootstrap facts outside a request', async () => {
  setup()
  await pgAuthEpoch('ALICE')
  await pgAuthMainAdmin('ALICE')
  expect(state.query).toHaveBeenCalledTimes(2)
})
