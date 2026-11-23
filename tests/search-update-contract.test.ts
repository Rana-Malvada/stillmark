import { expect, it } from 'vitest'
import { SEARCH_UPDATE_MAX_MS, searchUpdatePlan } from '@/lib/search/search-update'

const created_at = '2026-11-21T10:00:00.000Z'
it('retains typed root fields and accepts driver bigint elapsed time strings', () => {
  const run = { id: 'root', created_at, photo_limit: 10, photos_done: 3, elapsed_ms: '1200' }
  const child = { ...run, id: 'child', created_at: '2026-11-21T11:00:00.000Z', photos_done: 2 }
  const plan = searchUpdatePlan([child, run], 10, Date.parse(created_at) + 100)
  expect(plan.root.id).toBe('root')
  expect(plan).toMatchObject({
    remaining: 5,
    photoElapsedMs: 2400,
    deadline: Date.parse(created_at) + SEARCH_UPDATE_MAX_MS,
    expired: false,
  })
})
it('fails closed before scheduling when a chain or persisted deadline is invalid', () => {
  expect(() => searchUpdatePlan([], 0)).toThrow('Missing search update chain')
  expect(() => searchUpdatePlan([{ created_at: 'broken', photo_limit: 10 }], 0)).toThrow(
    'Invalid search update deadline',
  )
  for (const value of [NaN, Infinity, -1, 1.5]) {
    expect(() => searchUpdatePlan([{ created_at, photo_limit: value }], 0)).toThrow(
      'Invalid search update photo limit',
    )
    expect(() => searchUpdatePlan([{ created_at, photo_limit: 10 }], value)).toThrow(
      'Invalid search update pending count',
    )
  }
})
it('keeps the original deadline and never admits negative or extra work', () => {
  const run = {
    created_at: new Date(created_at),
    photo_limit: 10,
    photos_done: 12,
    elapsed_ms: null,
  }
  expect(searchUpdatePlan([run], 100, Date.parse(created_at) + SEARCH_UPDATE_MAX_MS)).toMatchObject(
    { remaining: 0, expired: true, photoElapsedMs: 0 },
  )
})
