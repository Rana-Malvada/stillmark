import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  query: vi.fn(async (_sql: string, _params?: unknown[]) => [] as any[]),
}))
vi.mock('react', () => ({ cache: (f: unknown) => f }))
vi.mock('@/lib/identity/auth', () => ({
  getCallerIdentity: async () => ({ username: 'ALICE', role: 'viewer' }),
}))
vi.mock('@/lib/postgres', () => ({
  getDatabaseIdentity: async () => ({ mainAdmin: false }),
  pgQuery: state.query,
  pgQueryOne: vi.fn(),
  pgTransaction: async (f: () => unknown) => f(),
}))
import { albumMutation } from '@/lib/albums/album-access'

afterEach(() => {
  vi.unstubAllEnvs()
  state.query.mockReset()
  state.query.mockResolvedValue([])
})
it('locks shared catalog then unique sorted album IDs before authorization/mutation', async () => {
  state.query.mockImplementation(async (sql) =>
    sql.startsWith('SELECT photo_id') ? [{ photo_id: 1, event_id: 9 }] : [],
  )
  const action = vi.fn(async () => {
    expect(state.query.mock.calls.at(-1)).toEqual(['SELECT pg_advisory_xact_lock($1)', [9]])
    return 'ok'
  })
  expect(await albumMutation(action, { eventIds: [9, 2, 2], photoIds: [1] })).toBe('ok')
  expect(state.query.mock.calls[0][0]).toContain('lock_shared')
  expect(state.query.mock.calls.slice(2)).toEqual([
    ['SELECT pg_advisory_xact_lock($1)', [2]],
    ['SELECT pg_advisory_xact_lock($1)', [9]],
  ])
})
it('keeps unscoped operations exclusive and missing photos fail before mutation', async () => {
  await albumMutation(async () => {})
  expect(state.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock(')
  const action = vi.fn()
  await expect(albumMutation(action, { photoIds: [99] })).rejects.toMatchObject({ status: 404 })
  expect(action).not.toHaveBeenCalled()
})
