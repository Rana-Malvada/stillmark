import { HttpError } from '../http'

/** Decode the common Cortex REST/SQL envelope without changing service rank order. */
export function searchProviderMatches(payload: unknown, column: 'PHOTO_ID' | 'EVENT_ID') {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('results' in payload) ||
    !Array.isArray(payload.results)
  ) {
    throw new HttpError(503, 'Search by meaning returned an invalid response')
  }
  const matches = new Map<number, Record<string, number>>()
  for (const row of payload.results) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const rawId = row[column]
    if (typeof rawId !== 'number' && typeof rawId !== 'string') continue
    const id = Number(rawId)
    if (!Number.isSafeInteger(id) || id <= 0 || matches.has(id)) continue
    const raw = row['@scores']
    const scores: Record<string, number> = {}
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const key of ['reranker_score', 'cosine_similarity', 'text_match']) {
        const value = raw[key]
        if (typeof value === 'number' && Number.isFinite(value)) scores[key] = value
      }
    }
    matches.set(id, scores)
  }
  return matches
}
