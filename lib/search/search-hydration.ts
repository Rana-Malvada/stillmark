import { prioritizePhotoEvidence, protectEvidence, supportedEvidence } from './search-evidence'

/** Each rank key depends only on the row. Stable top-k reduction therefore retains
 * exactly the same result as ranking the complete, retrieval-ordered candidate list.
 * Never trim before evidence validation: late exact matches must remain eligible. */
export async function hydrateRankedPhotos<T extends Record<string, unknown>>(
  query: string,
  ids: number[],
  limit: number,
  load: (ids: number[]) => Promise<T[]>,
  signal?: AbortSignal,
): Promise<T[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Invalid search hydration limit')
  async function* candidates() {
    yield* ids
  }
  return hydrateRankedCandidates(query, candidates(), limit, load, signal)
}

export async function* candidateBatches<T>(rows: AsyncIterable<T>, signal?: AbortSignal) {
  let batch: T[] = []
  for await (const row of rows) {
    signal?.throwIfAborted()
    batch.push(row)
    if (batch.length === 200) {
      yield batch
      batch = []
    }
  }
  if (batch.length) yield batch
}

export async function hydrateRankedCandidates<C, T extends Record<string, unknown>>(
  query: string,
  candidates: AsyncIterable<C>,
  limit: number,
  load: (batch: C[]) => Promise<T[]>,
  signal?: AbortSignal,
): Promise<T[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Invalid search hydration limit')
  let best: T[] = []
  for await (const batch of candidateBatches(candidates, signal)) {
    signal?.throwIfAborted()
    const rows = await load(batch)
    signal?.throwIfAborted()
    best = supportedEvidence(
      query,
      protectEvidence(query, prioritizePhotoEvidence([...best, ...rows])),
    ).slice(0, limit)
  }
  return best
}
