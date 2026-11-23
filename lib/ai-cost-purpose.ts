export type AiCostKind = 'photo_ai' | 'video_ai' | 'search_ai' | 'search_indexing' | 'other_ai'
/** Search refresh metadata takes precedence over inherited parent task tags. */
export function aiCostPurpose(
  row: Record<string, unknown>,
  category?: string,
): AiCostKind | 'pending_embedding' {
  const source = String(row.SOURCE_KIND ?? '')
  const verified = String(row.VERIFIED_KIND ?? row.HISTORY_KIND ?? row.history_kind ?? '')
  if (source === 'search_indexing' || verified === 'search_indexing') return 'search_indexing'
  if (source === 'pending_embedding') return 'pending_embedding'
  if (source === 'search_ai' || verified === 'search_ai') return 'search_ai'
  if (category === 'search_ai') return 'search_ai'
  if (category === 'photo_ai' || category === 'video_ai') return category
  if (verified === 'photo_ai' || verified === 'video_ai') return verified
  // Legacy mixed 'ai', absent tags and unknown tasks are deliberately unattributed.
  return 'other_ai'
}
