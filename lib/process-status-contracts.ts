/** Validate the fields consumed by processing panels before updating visible status. */
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
const text = (value: unknown) => typeof value === 'string'
const nullableText = (value: unknown) => value == null || text(value)
const counts = (value: unknown, keys: string[]) =>
  record(value) && keys.every((key) => count(value[key]))
const rows = (value: unknown, check: (row: Record<string, unknown>) => boolean) =>
  Array.isArray(value) && value.every((row) => record(row) && check(row))
const photo = (row: Record<string, unknown>) =>
  count(row.photo_id) && Number(row.photo_id) > 0 && text(row.source_filename)
const run = (value: unknown) =>
  value == null ||
  (record(value) &&
    text(value.id) &&
    text(value.status) &&
    count(value.total) &&
    text(value.created_at) &&
    nullableText(value.finished_at) &&
    nullableText(value.idle_since) &&
    nullableText(value.error))
export function isFaceScanStatus(value: unknown): boolean {
  return (
    record(value) &&
    (value.summary == null ||
      counts(value.summary, ['total', 'scanned', 'pending', 'failed', 'owners'])) &&
    run(value.run) &&
    (value.run == null || counts(value.run, ['processed', 'failed', 'faces_found'])) &&
    (value.progress == null || counts(value.progress, ['done', 'running', 'queued', 'failed'])) &&
    rows(value.failures, (row) => photo(row) && nullableText(row.error)) &&
    nullableText(value.statusWarning) &&
    typeof value.continuing === 'boolean' &&
    count(value.estimatedMinutes)
  )
}
export function isVideoPreparationStatus(value: unknown): boolean {
  return (
    record(value) &&
    counts(value.summary, ['total', 'ready', 'pending', 'skipped']) &&
    run(value.run) &&
    (value.progress == null ||
      counts(value.progress, ['ready', 'running', 'queued', 'failed', 'skipped'])) &&
    rows(value.failures, (row) => photo(row) && nullableText(row.error)) &&
    rows(value.excluded, photo) &&
    nullableText(value.statusWarning) &&
    (value.retries === undefined ||
      rows(
        value.retries,
        (row) =>
          photo(row) &&
          text(row.status) &&
          count(row.attempts) &&
          nullableText(row.next_attempt_at) &&
          text(row.error),
      ))
  )
}
export function isActivityStatus(value: unknown): boolean {
  return (
    record(value) &&
    record(value.summary) &&
    Object.values(value.summary).every(
      (v) => count(v) || (typeof v === 'string' && /^\d+$/.test(v) && count(Number(v))),
    ) &&
    text(value.asOf) &&
    (value.sync == null ||
      (record(value.sync) &&
        nullableText(value.sync.last_success) &&
        nullableText(value.sync.last_error))) &&
    rows(
      value.uploads,
      (row) =>
        text(row.source_filename) &&
        text(row.status) &&
        nullableText(row.error_message) &&
        text(row.started_at) &&
        nullableText(row.event_name) &&
        (row.event_id == null || count(row.event_id)),
    ) &&
    rows(
      value.failures,
      (row) => photo(row) && nullableText(row.ai_error) && count(row.ai_attempts),
    ) &&
    rows(
      value.cleanup,
      (row) => text(row.path) && count(row.attempts) && nullableText(row.last_error),
    )
  )
}
