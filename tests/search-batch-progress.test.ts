import { expect, it } from 'vitest'
import { searchBatchProgress } from '@/lib/search/search-batch-progress'

const root = {
  id: 'parent',
  status: 'completed',
  photo_limit: 100,
  search_limit: 20,
  photos_done: 100,
  failures: 0,
}
it('does not call the entire update complete while its follow-up is pending', () => {
  expect(searchBatchProgress(root)).toMatchObject({
    status: 'follow-up pending',
    active: true,
    photosDone: 100,
    canStop: true,
  })
})
it('shows the ranking child and keeps original photo progress after latest run changes', () => {
  const child = {
    id: 'child',
    status: 'running',
    photo_limit: 0,
    search_limit: 20,
    photos_done: 0,
    searches_done: 7,
  }
  expect(searchBatchProgress(child, root)).toMatchObject({
    status: 'running',
    rootId: 'parent',
    followupId: 'child',
    photosDone: 100,
    searchesDone: 7,
    canStop: true,
  })
})
it('shows failed follow-ups instead of the completed parent status', () => {
  expect(searchBatchProgress({ ...root, pipeline_error: 'Publishing failed' })).toMatchObject({
    status: 'failed',
    message: 'Publishing failed',
    active: false,
  })
  expect(
    searchBatchProgress({ id: 'child', status: 'failed', error: 'Worker failed' }, root),
  ).toMatchObject({ status: 'failed', active: false })
})
it('requires the follow-up to finish before showing completion', () => {
  expect(
    searchBatchProgress({ id: 'child', status: 'completed', searches_done: 20 }, root),
  ).toMatchObject({ status: 'completed', active: false, photosDone: 100, searchesDone: 20 })
})
it('keeps a missing linked follow-up pending instead of claiming completion', () => {
  expect(searchBatchProgress({ ...root, continued_by: 'missing' })).toMatchObject({
    status: 'follow-up pending',
  })
})
it('shows failures and cancellation in the child', () => {
  expect(searchBatchProgress({ status: 'completed', failures: 2 }, root).status).toBe(
    'completed with failures',
  )
  expect(searchBatchProgress({ status: 'cancelled' }, root)).toMatchObject({
    status: 'cancelled',
    active: false,
  })
})
it('does not invent a follow-up for enrichment-only or ranking-only jobs', () => {
  expect(searchBatchProgress({ ...root, search_limit: 0 })).toMatchObject({
    status: 'completed',
    active: false,
  })
  expect(searchBatchProgress({ ...root, photo_limit: 0 })).toMatchObject({
    status: 'completed',
    active: false,
  })
})

it('offers retry only for a failed unlinked enrichment follow-up', () => {
  expect(searchBatchProgress({ ...root, pipeline_error: 'Failed' }).canRetryFollowup).toBe(true)
  for (const overrides of [
    { continued_by: 'child' },
    { status: 'running' },
    { photo_limit: 0 },
    { search_limit: 0 },
    { pipeline_error: null },
  ]) {
    expect(
      searchBatchProgress({ ...root, pipeline_error: 'Failed', ...overrides }).canRetryFollowup,
    ).toBe(false)
  }
})

it('distinguishes a finished limited batch from an empty enrichment queue', () => {
  const child = { id: 'child', status: 'completed', searches_done: 1 }
  const result = searchBatchProgress(
    child,
    { ...root, photo_limit: 4200, photos_done: 4200 },
    undefined,
    502,
  )
  expect(result.status).toBe('batch finished — photos remaining')
  expect(result.message).toContain('502 photos are still queued')
  expect(result.message).toContain('reached its photo limit')
  expect(result.active).toBe(false)
})
it('does not hide a failed or running pipeline behind remaining work', () => {
  expect(searchBatchProgress({ status: 'failed' }, root, undefined, 502).status).toBe('failed')
  expect(searchBatchProgress({ status: 'running' }, root, undefined, 502).active).toBe(true)
})
it('does not claim the photo limit caused a partial timed batch to end', () => {
  const result = searchBatchProgress(
    { status: 'completed' },
    { ...root, photos_done: 50 },
    undefined,
    502,
  )
  expect(result.message).not.toContain('reached its photo limit')
  expect(result.message).toContain('remaining photos')
})
