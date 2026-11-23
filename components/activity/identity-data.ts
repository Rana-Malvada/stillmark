export type IdentityStatus = {
  provider: string
  completed_at: string | null
  imported: number
  error: string | null
  more: boolean
}
export type IdentitySummary = { rows: Record<string, string | number | null>[]; more: boolean }
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
const text = (v: unknown) => typeof v === 'string'
export function isIdentityStatus(value: unknown): value is IdentityStatus[] {
  return (
    Array.isArray(value) &&
    value.every(
      (s) =>
        record(s) &&
        text(s.provider) &&
        count(s.imported) &&
        typeof s.more === 'boolean' &&
        (s.error === null || text(s.error)) &&
        (s.completed_at === null ||
          (text(s.completed_at) && Number.isFinite(Date.parse(s.completed_at)))),
    )
  )
}
export function isIdentitySummary(value: unknown): value is IdentitySummary {
  return (
    record(value) &&
    typeof value.more === 'boolean' &&
    Array.isArray(value.rows) &&
    value.rows.every(
      (r) =>
        record(r) &&
        ['day', 'kind', 'provider'].every((k) => text(r[k])) &&
        ['events', 'successes', 'failures'].every((k) => count(r[k])) &&
        ['displayName', 'email'].every((k) => r[k] == null || text(r[k])) &&
        Object.values(r).every(
          (v) => v === null || text(v) || (typeof v === 'number' && Number.isFinite(v)),
        ),
    )
  )
}
export function isIdentityImport(value: unknown): value is { imported: number; more: boolean } {
  return record(value) && count(value.imported) && typeof value.more === 'boolean'
}
