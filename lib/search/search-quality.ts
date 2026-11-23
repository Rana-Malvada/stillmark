export function hasSearchEvidence(row: Record<string, unknown>) {
  const scores = row.scores as Record<string, number> | undefined
  const rank = scores?.reranker_score
  return (
    row.keywordMatch === true ||
    Number(row.keywordScore) > 0 ||
    row.subjectMatch === true ||
    (typeof rank === 'number' && Number.isFinite(rank) && rank >= -10)
  )
}
// Use the existing calibrated weak-score boundary independently for each candidate.
// Unscored provider candidates without local evidence remain available as related results.
export function applySearchQuality<
  T extends { source: string; count: number; results: Record<string, unknown>[] },
>(result: T, includeRelated = false): T & { relatedAvailable?: boolean; notice?: string } {
  if (result.source !== 'semantic') return result
  const matches = result.results.filter(hasSearchEvidence)
  if (matches.length === result.results.length) return result
  return {
    ...result,
    results: includeRelated ? result.results : matches,
    count: includeRelated ? result.count : matches.length,
    relatedAvailable: !includeRelated,
    notice: includeRelated
      ? 'Showing loosely related results alongside matches.'
      : matches.length
        ? 'Lower-confidence results are available separately.'
        : 'No strong matches found. Try a broader description or view related results.',
  }
}
