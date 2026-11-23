import { SearchSortBuffer } from './search-sort-buffer'

/** Internal fixed SQL clauses with bound values; never accept from a request. */
export interface SearchEligibility {
  where: string
  params: unknown[]
}
export type EligibleMatch = { id: number; scores: Record<string, number>; order: number }

/** Every constrained partition is searched. The callback owns a bounded-memory,
 * exactly ordered stream; all private scratch files are removed on every exit. */
export async function withEligibleMatches<T>(
  load: (after: number, limit: number) => Promise<number[]>,
  retrieve: (ids: number[]) => Promise<Map<number, Record<string, number>>>,
  concurrency: number,
  use: (matches: SearchSortBuffer<EligibleMatch>) => Promise<T>,
  signal?: AbortSignal,
) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error('Invalid search partition concurrency')
  const size = 5000 * concurrency
  let total = 0
  let order = 0
  const matches = new SearchSortBuffer<EligibleMatch>(
    (a, b) =>
      (total > 5000
        ? (b.scores.reranker_score ?? -Infinity) - (a.scores.reranker_score ?? -Infinity)
        : 0) || a.order - b.order,
    signal,
  )
  try {
    let after = 0
    while (true) {
      signal?.throwIfAborted()
      const ids = await load(after, size)
      signal?.throwIfAborted()
      if (!ids.length) break
      if (
        ids.length > size ||
        ids.some((id, i) => !Number.isSafeInteger(id) || id <= (i ? ids[i - 1] : after))
      )
        throw new Error('Invalid search eligibility page')
      const page = await retrieve(ids)
      signal?.throwIfAborted()
      const allowed = new Set(ids)
      total += ids.length
      // Provider indexes may lag permission/metadata changes. Discard candidates
      // outside this live authorized partition without losing valid matches.
      await matches.add(
        Array.from(page, ([id, scores]) => ({ id, scores, order: order++ })).filter((row) =>
          allowed.has(row.id),
        ),
      )
      after = ids[ids.length - 1]
      if (ids.length < size) break
    }
    return await use(matches)
  } finally {
    await matches.dispose()
  }
}

/** Rank fusion preserves the existing lexical/semantic/visual weights and tie
 * order, without materializing the complete union or its scores in a JS Map. */
export async function withFusedMatches<T>(
  semantic: SearchSortBuffer<EligibleMatch>,
  lexical: number[],
  visual: number[],
  use: (rows: AsyncIterable<EligibleMatch>) => Promise<T>,
  signal?: AbortSignal,
) {
  const lexicalRanks = new Map([...new Set(lexical)].map((id, i) => [id, i + 1]))
  const boostedIds = new Set([...lexical, ...visual])
  const retrieved = new Map<number, { row: EligibleMatch; rank: number }>()
  const supported = new Set(lexical)
  // Only the bounded lexical/visual lists can change semantic rank order.
  // Retain those intersections, then merge them with the remaining ordered
  // stream instead of sorting/writing every semantic candidate a second time.
  let rank = 0
  for await (const row of semantic.ordered()) {
    signal?.throwIfAborted()
    rank++
    if (boostedIds.has(row.id)) {
      retrieved.set(row.id, { row, rank })
      supported.add(row.id)
    }
  }
  const visualRanks = new Map(
    [...new Set(visual.filter((id) => supported.has(id)).slice(0, 100))].map((id, i) => [
      id,
      i + 1,
    ]),
  )
  const score = (id: number, semanticRank?: number) =>
    (semanticRank ? 1 / (60 + semanticRank) : 0) +
    (lexicalRanks.has(id) ? 1 / (60 + lexicalRanks.get(id)!) : 0) +
    (visualRanks.has(id) ? 0.25 / (60 + visualRanks.get(id)!) : 0)
  const boosted = new Set([...lexicalRanks.keys(), ...visualRanks.keys()])
  const compare = (a: EligibleMatch & { fused: number }, b: EligibleMatch & { fused: number }) =>
    b.fused - a.fused || a.id - b.id
  const ranked = [...boosted]
    .map((id) => {
      const match = retrieved.get(id)
      return { ...(match?.row ?? { id, scores: {}, order: 0 }), fused: score(id, match?.rank) }
    })
    .sort(compare)
  async function* merged() {
    let rank = 0
    let next = 0
    for await (const row of semantic.ordered()) {
      signal?.throwIfAborted()
      rank++
      if (boosted.has(row.id)) continue
      const normal = { ...row, fused: score(row.id, rank) }
      while (next < ranked.length && compare(ranked[next], normal) < 0) yield ranked[next++]
      yield normal
    }
    while (next < ranked.length) {
      signal?.throwIfAborted()
      yield ranked[next++]
    }
  }
  return use(merged())
}
export function searchPartitionConcurrency() {
  const configured = Number(process.env.SEARCH_PARTITION_CONCURRENCY ?? 2)
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 8 ? configured : 2
}
