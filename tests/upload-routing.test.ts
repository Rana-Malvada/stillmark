import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  one: vi.fn(),
  lock: vi.fn(),
  step: vi.fn(),
  transaction: vi.fn(),
}))
vi.mock('@/lib/postgres', () => ({
  pgQuery: mocks.query,
  pgQueryOne: mocks.one,
  pgTransaction: mocks.transaction,
  withAdvisoryLock: mocks.lock,
}))
vi.mock('@/lib/upload/upload-routing-control', () => ({ uploadPoolStep: mocks.step }))
import { maintainUploadRouting, requestUploadMode } from '@/lib/upload/upload-routing'
import { withUploadPoolAdmission } from '@/lib/upload/upload-routing-admission'
import {
  databaseContext,
  databaseSignal,
  withDatabaseRequest,
} from '@/lib/database/database-context'

beforeEach(() => {
  vi.stubEnv('UPLOAD_ROUTING_MANAGED', 'true')
  vi.stubEnv('UPLOAD_SERVICE_ONLY', 'true')
  mocks.query.mockReset().mockResolvedValue([])
  mocks.transaction.mockReset().mockImplementation(async (fn) => fn())
  mocks.one.mockReset()
  mocks.step.mockReset().mockResolvedValue(true)
  mocks.lock.mockReset().mockImplementation(async (_n, fn) => fn())
})
const state = (overrides = {}) => ({
  enabled: true,
  phase: 'pool',
  desired: 'pool',
  route: 'pool',
  active: 0,
  updated_at: new Date().toISOString(),
  last_activity_at: new Date().toISOString(),
  ...overrides,
})
it('does not suspend before fifteen minutes or while transfers or jobs are active', async () => {
  for (const overrides of [
    { last_activity_at: new Date(Date.now() - 899000).toISOString() },
    { active: 1, last_activity_at: new Date(0).toISOString() },
    { phase: 'suspended' },
    { phase: 'error' },
  ]) {
    mocks.one.mockResolvedValue(state(overrides))
    await maintainUploadRouting()
  }
  expect(mocks.step).not.toHaveBeenCalled()
})
it('fences admission then suspends after fifteen idle minutes', async () => {
  mocks.one.mockResolvedValue(
    state({ last_activity_at: new Date(Date.now() - 900001).toISOString() }),
  )
  await maintainUploadRouting()
  expect(mocks.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock')
  expect(mocks.step).toHaveBeenCalledWith('suspend')
  expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual(['suspended'])
})
it('rechecks new work before suspending', async () => {
  mocks.one
    .mockResolvedValueOnce(state({ last_activity_at: new Date(0).toISOString() }))
    .mockResolvedValueOnce(state({ active: 1 }))
  await maintainUploadRouting()
  expect(mocks.step).not.toHaveBeenCalled()
})
it('upload intent wakes a suspended pool without selecting SAR', async () => {
  mocks.one.mockResolvedValue(state({ phase: 'suspended' }))
  await requestUploadMode('pool', 'member')
  expect(mocks.query.mock.calls.at(-1)?.[0]).toContain("route='pool'")
  expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual(['member'])
})
it('does not mark ready until containers are ready', async () => {
  mocks.one.mockResolvedValue(state({ phase: 'resuming' }))
  mocks.step.mockResolvedValue(false)
  await maintainUploadRouting()
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes('SET phase=$1'))).toBe(false)
  mocks.step.mockResolvedValue(true)
  await maintainUploadRouting()
  expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual(['pool'])
})
it('DDL failure exposes an error without app fallback', async () => {
  mocks.one.mockResolvedValue(state({ phase: 'resuming' }))
  mocks.step.mockRejectedValue(new Error('timeout'))
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await maintainUploadRouting()
  expect(mocks.query.mock.calls.at(-1)?.[0]).toContain("phase='error'")
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes("route='app'"))).toBe(false)
  spy.mockRestore()
})
it('SAR refuses upload processing even with managed routing disabled', async () => {
  vi.stubEnv('UPLOAD_SERVICE_ONLY', 'false')
  vi.stubEnv('UPLOAD_ROUTING_MANAGED', 'false')
  const work = vi.fn()
  await expect(withUploadPoolAdmission('owner', work)).rejects.toThrow('separate upload service')
  expect(work).not.toHaveBeenCalled()
})
it('fences delayed pool requests before running their work', async () => {
  mocks.one.mockResolvedValue({ enabled: true, route: 'app' })
  const work = vi.fn()
  await expect(withUploadPoolAdmission('owner', work)).rejects.toThrow('routing changed')
  expect(work).not.toHaveBeenCalled()
  expect(mocks.query.mock.calls.some(([s]) => s.startsWith('INSERT'))).toBe(false)
})
it('keeps admission present until work settles and releases on failure', async () => {
  mocks.one.mockResolvedValue({ enabled: true, route: 'pool', phase: 'pool' })
  let finish!: () => void
  const work = vi.fn(
    () =>
      new Promise<void>((r) => {
        finish = r
      }),
  )
  const pending = withUploadPoolAdmission('owner', work)
  await vi.waitFor(() => expect(work).toHaveBeenCalled())
  expect(mocks.query.mock.calls.some(([s]) => s.startsWith('DELETE'))).toBe(false)
  finish()
  await pending
  expect(mocks.query.mock.calls.at(-1)?.[0]).toContain('DELETE FROM upload_pool_requests')
  await expect(
    withUploadPoolAdmission('owner', async () => {
      throw new Error('upload failed')
    }),
  ).rejects.toThrow('upload failed')
  expect(mocks.query.mock.calls.at(-1)?.[0]).toContain('DELETE FROM upload_pool_requests')
})

it('releases a disconnected request under the same identity after its work settles', async () => {
  mocks.one.mockResolvedValue({ route: 'pool', phase: 'pool' })
  const controller = new AbortController()
  const caller = Promise.resolve({ username: 'owner', role: 'viewer' as const })
  let finish!: () => void
  let cleanupSignal: AbortSignal | undefined
  mocks.query.mockImplementation(async (sql) => {
    databaseSignal()?.throwIfAborted()
    if (sql.startsWith('DELETE')) {
      const ctx = databaseContext.getStore()
      expect(ctx?.kind).toBe('request')
      expect(ctx && 'caller' in ctx && ctx.caller).toBe(caller)
      cleanupSignal = databaseSignal()
    }
    return []
  })
  const work = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const run = withDatabaseRequest(async (_req: Request) => {
    const ctx = databaseContext.getStore()!
    if (ctx.kind === 'request') ctx.caller = caller
    await withUploadPoolAdmission('owner', work)
    expect(databaseSignal()?.aborted).toBe(true)
  })
  const pending = run(new Request('https://app', { signal: controller.signal }))
  await vi.waitFor(() => expect(work).toHaveBeenCalled())
  controller.abort()
  expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(false)
  finish()
  await pending
  expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual([expect.any(String), 'owner'])
  expect(cleanupSignal).toBeDefined()
  expect(cleanupSignal?.aborted).toBe(false)
})

it('cleans up an ambiguous admission commit without replaying the upload', async () => {
  mocks.one.mockResolvedValue({ route: 'pool', phase: 'pool' })
  mocks.transaction.mockImplementationOnce(async (fn) => {
    await fn()
    throw new Error('COMMIT response lost')
  })
  const work = vi.fn()
  await expect(withUploadPoolAdmission('owner', work)).rejects.toThrow('COMMIT response lost')
  expect(work).not.toHaveBeenCalled()
  const insert = mocks.query.mock.calls.find(([sql]) => sql.startsWith('INSERT'))!
  const cleanupFence = mocks.query.mock.calls.at(-2)!
  expect(cleanupFence[0]).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))')
  expect(cleanupFence[1]).toEqual([insert[1][0]])
  expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual(insert[1])
  expect(mocks.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT'))).toHaveLength(1)
})
