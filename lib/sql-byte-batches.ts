/** Split already serialized rows without truncating evidence. Account for the SQL
 * wrapper and UTF-8 bytes, not JavaScript character count. Oversized individual
 * rows fail before any request so they remain queued for explicit remediation. */
export function sqlByteBatches<T>(
  records: T[],
  value: (record: T) => string,
  statement: (values: string[]) => string,
  maxBytes: number,
): { records: T[]; sql: string }[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw Error('Invalid SQL byte budget')
  const overhead = Buffer.byteLength(statement([]))
  const batches: { records: T[]; sql: string }[] = []
  let current: T[] = []
  let values: string[] = []
  let bytes = overhead
  const flush = () => {
    if (current.length) batches.push({ records: current, sql: statement(values) })
    current = []
    values = []
    bytes = overhead
  }
  for (const record of records) {
    const serialized = value(record)
    const size = Buffer.byteLength(serialized)
    if (overhead + size > maxBytes)
      throw Error('One search index document exceeds the SQL byte budget; nothing was truncated')
    const separator = values.length ? 2 : 0 // statement joins with comma + newline
    if (bytes + separator + size > maxBytes) flush()
    bytes += (values.length ? 2 : 0) + size
    current.push(record)
    values.push(serialized)
  }
  flush()
  return batches
}
export function searchSyncByteBudget() {
  const value = process.env.SEARCH_SYNC_MAX_SQL_BYTES ?? '1000000'
  if (!/^\d+$/.test(value) || Number(value) < 16384 || Number(value) > 16000000)
    throw Error('SEARCH_SYNC_MAX_SQL_BYTES must be between 16384 and 16000000')
  return Number(value)
}
