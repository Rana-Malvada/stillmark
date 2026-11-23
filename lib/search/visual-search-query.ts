import type { SearchEligibility } from './search-eligibility'

/** Both paths retain live Postgres RLS and current-source checks. A constrained
 * search reuses its exact SQL predicate rather than copying all matching IDs. */
export function visualSearchQuery(
  vector: number[],
  allowedIds: number[],
  eligibleIds: number[] | undefined,
  limit: number,
  eligibility?: SearchEligibility,
) {
  const params: unknown[] = eligibility
    ? [...eligibility.params]
    : [allowedIds, eligibleIds ?? null]
  const where = eligibility
    ? `(${eligibility.where})`
    : 'p.event_id=ANY($1::int[]) AND ($2::int[] IS NULL OR p.photo_id=ANY($2::int[]))'
  const vectorParam = `$${params.push(JSON.stringify(vector))}::vector`
  const limitParam = `$${params.push(limit)}::int`
  return {
    sql: `SELECT p.photo_id AS "photoId" FROM search_enrichment se JOIN photos p USING(photo_id)
    JOIN events e ON e.event_id=p.event_id
    WHERE se.status='completed' AND se.model_version='clip-b32@3d74acf9+ocr-tesseract5' AND se.visual_embedding IS NOT NULL
    AND p.ingest_status='READY' AND se.source_path=p.original_stage_path AND ${where}
    ORDER BY se.visual_embedding <=> ${vectorParam},p.photo_id LIMIT ${limitParam}`,
    params,
  }
}
