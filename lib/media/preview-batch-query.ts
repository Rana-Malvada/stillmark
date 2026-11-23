import { pgQuery } from '../postgres'

/** Execute with the current app role and request identity; never a maintenance connection. */
export const previewBatchSql = `SELECT DISTINCT thumbnail_stage_path FROM photos
 WHERE thumbnail_stage_path=ANY($1::text[]) AND ingest_status='READY'`

/**
 * The subset of the given thumbnail paths that belong to ready photos the caller can read.
 * Paths are selectors, never authority: row security decides which photos are visible.
 */
export async function readablePreviewPaths(paths: string[]): Promise<Set<string>> {
  const rows = await pgQuery<{ thumbnail_stage_path: string }>(previewBatchSql, [paths])
  return new Set(rows.map((row) => row.thumbnail_stage_path))
}

/**
 * Crop paths of the given faces the caller may see; other faces are absent. Row security
 * decides visibility, and owners also see their ignored faces. Paths are not validated.
 */
export function visibleFaceCropPaths(
  faceIds: number[],
): Promise<{ face_id: number; crop_path: string | null }[]> {
  return pgQuery<{ face_id: number; crop_path: string | null }>(
    `SELECT face_id,crop_path FROM faces WHERE face_id=ANY($1::bigint[]) AND (NOT ignored OR owner_username=photo_security.username())`,
    [faceIds],
  )
}
