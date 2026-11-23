import { beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ pg: vi.fn(), sf: vi.fn(), refresh: vi.fn(), sync: vi.fn() }))
vi.mock('@/lib/postgres', () => ({
  pgQuery: mock.pg,
  withAdvisoryLock: async (_name: string, fn: () => unknown) => fn(),
}))
vi.mock('@/lib/search/search-batch-control', () => ({ searchBatchCommand: mock.sf }))
vi.mock('@/lib/search/search-replay', () => ({ refreshSavedSearches: mock.refresh }))
vi.mock('@/lib/search/search-sync', () => ({ syncSearch: mock.sync }))
import {
  maintainSearchBatch,
  retrySearchFollowup,
  searchBatchStatus,
  stopSearchBatch,
} from '@/lib/search/search-batch'

let run: any
let chain: any[]
let pending: number
let outbox: boolean
beforeEach(() => {
  vi.resetAllMocks()
  run = {
    id: 'run',
    status: 'completed',
    photo_limit: 10000,
    photos_done: 5000,
    search_limit: 20,
    requested_by: 'owner',
    created_at: new Date().toISOString(),
    settled_at: 'now',
  }
  chain = [run]
  pending = 5000
  outbox = false
  mock.sf.mockResolvedValue({ status: 'DONE' })
  mock.pg.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.startsWith('WITH RECURSIVE')) return chain
    if (sql.startsWith('SELECT * FROM search_batch_runs ORDER')) return run ? [run] : []
    if (sql.startsWith('SELECT count(*)::int AS pending FROM search_enrichment'))
      return [{ pending }]
    if (sql.includes("count(*) FILTER(WHERE status='queued')")) return [{ pending }]
    if (sql === 'SELECT 1 FROM search_queue LIMIT 1') return outbox ? [{}] : []
    if (sql.startsWith('WITH child')) return [{ id: params[0] }]
    if (sql.startsWith("UPDATE search_batch_runs SET status='cancelled',finished_at=now()"))
      return run ? [{ id: run.id }] : []
    return []
  })
})
it('never launches just because uploads are pending', async () => {
  run = null
  await maintainSearchBatch()
  expect(mock.sf).not.toHaveBeenCalled()
})
it('continues remaining photos before publishing or ranking, with the original deadline', async () => {
  await maintainSearchBatch()
  const write = mock.pg.mock.calls.find(([sql]) => sql.startsWith('WITH child'))!
  expect(write[1].slice(1)).toEqual(['owner', 5000, 20, 'run'])
  expect(mock.sf).toHaveBeenCalledWith(
    write[1][0],
    'START',
    new Date(run.created_at).getTime() + 10800000,
  )
  expect(mock.sync).not.toHaveBeenCalled()
  expect(mock.refresh).not.toHaveBeenCalled()
})
it('uses cumulative work and the root start time after multiple continuations', async () => {
  const root = {
    ...run,
    id: 'root',
    created_at: new Date(Date.now() - 3600000).toISOString(),
    photos_done: 5000,
  }
  run = { ...run, photo_limit: 5000, photos_done: 1000 }
  chain = [run, root]
  pending = 4000
  await maintainSearchBatch()
  expect(mock.pg.mock.calls.find(([s]) => s.startsWith('WITH child'))![1][2]).toBe(4000)
  expect(mock.sf.mock.calls[0][2]).toBe(new Date(root.created_at).getTime() + 10800000)
})
it('publishes all queued changes before launching saved-search rankings', async () => {
  pending = 0
  outbox = true
  mock.sync.mockResolvedValue({ remaining: 100 })
  await maintainSearchBatch()
  expect(mock.sync).toHaveBeenCalledWith(
    expect.objectContaining({ force: true, signal: expect.any(AbortSignal) }),
  )
  expect(mock.sf).not.toHaveBeenCalled()
  expect(mock.refresh).not.toHaveBeenCalled()
  mock.sync.mockResolvedValue({ remaining: 0 })
  await maintainSearchBatch()
  expect(mock.refresh).toHaveBeenCalledWith(20, expect.any(AbortSignal))
  expect(mock.pg.mock.calls.find(([s]) => s.startsWith('WITH child'))![1][2]).toBe(0)
})
it('skips warehouse work when there are no queued index changes', async () => {
  pending = 0
  await maintainSearchBatch()
  expect(mock.sync).not.toHaveBeenCalled()
  expect(mock.refresh).toHaveBeenCalledWith(20, expect.any(AbortSignal))
})
it.each(['cancelled', 'failed'])('%s runs cannot continue', async (status) => {
  run.status = status
  await maintainSearchBatch()
  expect(mock.sf).not.toHaveBeenCalled()
  expect(mock.sync).not.toHaveBeenCalled()
})
it('stops at the original deadline, without starting further work', async () => {
  run.created_at = new Date(Date.now() - 10800001).toISOString()
  await maintainSearchBatch()
  expect(mock.sf).toHaveBeenCalledWith('run', 'CANCEL')
  expect(mock.pg.mock.calls.some(([s]) => s.startsWith('WITH child'))).toBe(false)
  expect(mock.refresh).not.toHaveBeenCalled()
})
it('recovers a committed child after interrupted submission using its same ID', async () => {
  run.status = 'starting'
  await maintainSearchBatch()
  expect(mock.sf).toHaveBeenCalledWith('run', 'START', expect.any(Number))
  expect(mock.pg.mock.calls.some(([s]) => s.startsWith('WITH child'))).toBe(false)
})
it('a ranking-only child does not recursively start another update', async () => {
  run.photo_limit = 0
  await maintainSearchBatch()
  expect(mock.sf).not.toHaveBeenCalled()
  expect(mock.refresh).not.toHaveBeenCalled()
})
it('persists publishing errors and does not silently retry paid warehouse work', async () => {
  pending = 0
  outbox = true
  mock.sync.mockRejectedValue(Object.assign(new Error('private query'), { code: '42501' }))
  await expect(maintainSearchBatch()).rejects.toThrow('private query')
  expect(mock.pg).toHaveBeenCalledWith(expect.stringContaining('pipeline_error=$2'), [
    'run',
    expect.stringContaining('Search publishing failed (42501)'),
  ])
  run.pipeline_error = 'failed'
  mock.sync.mockClear()
  await maintainSearchBatch()
  expect(mock.sync).not.toHaveBeenCalled()
})
it('status remains read only and aggregates photos over linked workers', async () => {
  chain = [run, { ...run, id: 'root', photos_done: 2000 }]
  const result = await searchBatchStatus()
  expect(result.pipeline?.photosDone).toBe(7000)
  expect(
    mock.pg.mock.calls.every(([s]) => s.startsWith('SELECT') || s.startsWith('WITH RECURSIVE')),
  ).toBe(true)
  expect(mock.sf).not.toHaveBeenCalled()
})
it('Stop cancels a completed worker awaiting continuation as well as active workers', async () => {
  await stopSearchBatch()
  expect(mock.pg).toHaveBeenCalledWith(expect.stringContaining("status='cancelled'"), [
    'Worker interrupted; automatic recovery pending',
  ])
  expect(mock.sf).toHaveBeenCalledWith('run', 'CANCEL')
})
it('rejects obsolete explicit retries', async () => {
  await expect(retrySearchFollowup('old')).rejects.toMatchObject({ status: 409 })
})

it('does not relabel an already finished enrichment-only update as timed out later', async () => {
  pending = 0
  run.search_limit = 0
  run.created_at = new Date(Date.now() - 10800001).toISOString()
  await maintainSearchBatch()
  expect(mock.sf).not.toHaveBeenCalled()
  expect(mock.pg.mock.calls.some(([s]) => s.includes("SET status='cancelled'"))).toBe(false)
})
