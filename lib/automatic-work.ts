import { pgQuery } from './postgres'

export type AutomaticWorkKind = 'faces' | 'playback' | 'ocr' | 'search'
export type AutomaticWorkSignal = { sourceId: number; sourceType: string; revision: string }

/** Read a bounded committed snapshot. Callers serialize admission with their
 * existing worker lock and acknowledge inside the same transaction as run creation. */
export async function listAutomaticWork(kind: AutomaticWorkKind, limit = 500) {
  const rows = await pgQuery<{ source_id: number; source_type: string; revision: string }>(
    `SELECT source_id,source_type,revision::text FROM automatic_work_signals
     WHERE kind=$1 ORDER BY revision LIMIT $2`,
    [kind, limit],
  )
  return rows.map((row): AutomaticWorkSignal => ({
    sourceId: Number(row.source_id),
    sourceType: row.source_type,
    revision: row.revision,
  }))
}

/** Exact revisions avoid swallowing an upload/revision committed during admission. */
export async function acknowledgeAutomaticWork(
  kind: AutomaticWorkKind,
  signals: AutomaticWorkSignal[],
) {
  if (!signals.length) return
  await pgQuery(
    `DELETE FROM automatic_work_signals s USING
    unnest($2::bigint[],$3::text[],$4::bigint[]) AS claimed(id,source_type,revision)
    WHERE s.kind=$1 AND s.source_id=claimed.id AND s.source_type=claimed.source_type
      AND s.revision=claimed.revision`,
    [
      kind,
      signals.map((s) => s.sourceId),
      signals.map((s) => s.sourceType),
      signals.map((s) => s.revision),
    ],
  )
}

/** Manual admission has already locked/written these queue rows in its transaction. */
export async function acknowledgeAutomaticSources(kind: AutomaticWorkKind, sourceIds: number[]) {
  if (!sourceIds.length) return
  await pgQuery(
    `DELETE FROM automatic_work_signals WHERE kind=$1 AND source_type='photo'
    AND source_id=ANY($2::bigint[])`,
    [kind, sourceIds],
  )
}
