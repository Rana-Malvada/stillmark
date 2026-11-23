import { expect, it } from 'vitest'
import { readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SearchSortBuffer } from '@/lib/search/search-sort-buffer'
import { withEligibleMatches, withFusedMatches } from '@/lib/search/search-eligibility'
import { fuseSearchRanks } from '@/lib/search/search-ranking'

async function collect<T>(rows: AsyncIterable<T>) {
  const result: T[] = []
  for await (const row of rows) result.push(row)
  return result
}
const scratch = async () =>
  (await readdir(tmpdir())).filter((name) => name.startsWith('stillmark-search-'))

it('sorts spilled multi-pass runs exactly, permits repeated reads, and removes private scratch files', async () => {
  const before = new Set(await scratch())
  const sorter = new SearchSortBuffer<{ id: number; score: number }>(
    (a, b) => b.score - a.score || a.id - b.id,
    undefined,
    2,
  )
  const rows = Array.from({ length: 99 }, (_, id) => ({ id, score: id % 7 })).reverse()
  try {
    await sorter.add(rows)
    const directories = (await scratch()).filter((name) => !before.has(name))
    expect(directories).toHaveLength(1)
    const dir = join(tmpdir(), directories[0])
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    for (const file of await readdir(dir))
      expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600)
    const expected = [...rows].sort((a, b) => b.score - a.score || a.id - b.id)
    expect(await collect(sorter.ordered())).toEqual(expected)
    expect(await collect(sorter.ordered())).toEqual(expected)
  } finally {
    await sorter.dispose()
  }
  expect((await scratch()).filter((name) => !before.has(name))).toEqual([])
})

it('cleans partially written runs after budget exhaustion and cancellation', async () => {
  const before = new Set(await scratch())
  const sorter = new SearchSortBuffer<number>((a, b) => a - b, undefined, 2, 3)
  try {
    await expect(sorter.add([100, 200])).rejects.toThrow('budget')
  } finally {
    await sorter.dispose()
  }
  const controller = new AbortController()
  const cancelled = new SearchSortBuffer<number>((a, b) => a - b, controller.signal, 2)
  try {
    await cancelled.add([4, 3, 2, 1])
    controller.abort()
    await expect(collect(cancelled.ordered())).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    await cancelled.dispose()
  }
  expect((await scratch()).filter((name) => !before.has(name))).toEqual([])
})

it('fuses every semantic candidate with exactly the existing lexical and corroborated visual ranking', async () => {
  const semanticIds = Array.from({ length: 20001 }, (_, i) => i + 1)
  const lexical = [9, 7, 30000, 4, 9]
  const visual = [20001, 30000, 90000, 4, 7, 7]
  await withEligibleMatches(
    async (after, limit) => semanticIds.filter((id) => id > after).slice(0, limit),
    async (ids) => new Map(ids.map((id) => [id, { reranker_score: id % 13 }])),
    2,
    async (semantic) => {
      const sorted = [...semanticIds].sort((a, b) => (b % 13) - (a % 13) || a - b)
      expect((await collect(semantic.ordered())).map((row) => row.id)).toEqual(sorted)
      await withFusedMatches(semantic, lexical, visual, async (rows) => {
        const actual = await collect(rows)
        expect(actual.map((row) => row.id)).toEqual(fuseSearchRanks([lexical, sorted], visual))
        expect(actual.find((row) => row.id === 20001)?.scores).toEqual({
          reranker_score: 20001 % 13,
        })
        expect(actual.find((row) => row.id === 30000)?.scores).toEqual({})
        expect(actual.some((row) => row.id === 90000)).toBe(false)
      })
    },
  )
})

it('discards out-of-partition provider results while preserving authorized matches', async () => {
  const rows = await withEligibleMatches(
    async () => [1, 2],
    async () =>
      new Map([
        [3, {}],
        [2, {}],
        [1, {}],
      ]),
    2,
    async (matches) => collect(matches.ordered()),
  )
  expect(rows.map((row) => row.id)).toEqual([2, 1])
})

it('matches rank fusion across empty channels, duplicate visual ranks and equal channel scores', async () => {
  for (let seed = 0; seed < 20; seed++) {
    const ids = Array.from({ length: 201 }, (_, id) => id + 1)
    const semanticIds = ids.filter((id) => (id + seed) % 3 !== 0)
    const lexical = seed % 4 ? [...ids].reverse().filter((id) => (id + seed) % 7 === 0) : []
    const visual = seed % 5 ? [...ids, ...ids].filter((id) => (id + seed) % 2 === 0) : []
    await withEligibleMatches(
      async () => ids,
      async () => new Map(semanticIds.map((id) => [id, {}])),
      2,
      async (semantic) =>
        withFusedMatches(semantic, lexical, visual, async (rows) => {
          expect((await collect(rows)).map((row) => row.id)).toEqual(
            fuseSearchRanks([lexical, semanticIds], visual),
          )
        }),
    )
  }
})

it('keeps small searches in memory and cleans up even if the consumer fails', async () => {
  const before = new Set(await scratch())
  await expect(
    withEligibleMatches(
      async () => [1, 2],
      async () =>
        new Map([
          [2, {}],
          [1, {}],
        ]),
      2,
      async (rows) => {
        expect((await collect(rows.ordered())).map((row) => row.id)).toEqual([2, 1])
        expect((await scratch()).filter((name) => !before.has(name))).toEqual([])
        throw new Error('consumer failed')
      },
    ),
  ).rejects.toThrow('consumer failed')
})
