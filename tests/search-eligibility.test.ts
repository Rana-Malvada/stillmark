import { expect, it, vi } from 'vitest'
import { withEligibleMatches } from '@/lib/search/search-eligibility'

// Test-only materialization; production consumes the bounded ordered stream.
const collectEligibleMatches = (
  load: (after: number, limit: number) => Promise<number[]>,
  retrieve: (ids: number[]) => Promise<Map<number, Record<string, number>>>,
  concurrency: number,
  signal?: AbortSignal,
) =>
  withEligibleMatches(
    load,
    retrieve,
    concurrency,
    async (matches) => {
      const result = new Map<number, Record<string, number>>()
      for await (const row of matches.ordered()) result.set(row.id, row.scores)
      return result
    },
    signal,
  )

it('consumes every constrained ID in bounded keyset pages and globally orders partition matches', async () => {
  const ids = Array.from({ length: 25001 }, (_, i) => 2 * i + 1)
  const load = vi.fn(async (after: number, limit: number) =>
    ids.filter((id) => id > after).slice(0, limit),
  )
  const seen: number[] = []
  const retrieve = vi.fn(async (page: number[]) => {
    seen.push(...page)
    return new Map([[page[0], { reranker_score: page[0] }]])
  })
  const result = await collectEligibleMatches(load, retrieve, 2)
  expect(load.mock.calls).toEqual([
    [0, 10000],
    [19999, 10000],
    [39999, 10000],
  ])
  expect(seen).toEqual(ids)
  expect([...result.keys()]).toEqual([40001, 20001, 1])
})

it('handles an exact page boundary without repeating a partition', async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce(Array.from({ length: 5000 }, (_, i) => i + 1))
    .mockResolvedValueOnce([])
  const retrieve = vi.fn(
    async () =>
      new Map([
        [9, {}],
        [1, {}],
      ]),
  )
  expect([...(await collectEligibleMatches(load, retrieve, 1))]).toEqual([
    [9, {}],
    [1, {}],
  ])
  expect(retrieve).toHaveBeenCalledTimes(1)
  expect(load.mock.calls[1]).toEqual([5000, 5000])
})

it('does not schedule another page or retrieval after cancellation', async () => {
  const controller = new AbortController()
  const load = vi.fn(async () => {
    controller.abort()
    return [1]
  })
  const retrieve = vi.fn()
  await expect(collectEligibleMatches(load, retrieve, 2, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  })
  expect(retrieve).not.toHaveBeenCalled()
  expect(load).toHaveBeenCalledTimes(1)
})

it.each([[1, 1], [2, 1], [0], [-1], [1.5]])(
  'rejects invalid cursor progress %j',
  async (...page) => {
    const retrieve = vi.fn()
    await expect(collectEligibleMatches(async () => page, retrieve, 2)).rejects.toThrow(
      'Invalid search eligibility page',
    )
    expect(retrieve).not.toHaveBeenCalled()
  },
)

it('propagates a failed page rather than claiming the remaining partitions were searched', async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce(Array.from({ length: 5000 }, (_, i) => i + 1))
    .mockRejectedValueOnce(new Error('query failed'))
  const retrieve = vi.fn(async () => new Map([[1, {}]]))
  await expect(collectEligibleMatches(load, retrieve, 1)).rejects.toThrow('query failed')
  expect(retrieve).toHaveBeenCalledTimes(1)
})
