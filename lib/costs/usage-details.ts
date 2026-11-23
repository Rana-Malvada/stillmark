/** Explicit metadata allowlist: never persist request bodies, error text or tokens. */
export interface UsageDetails {
  seconds?: number
  bytes?: number
  files?: number
  durationMs?: number
  results?: number
  status?: number
  provider?: string
  code?: string
  method?: string
  query?: string
  mode?: string
  outcome?: string
  scope?: string
}
export function cleanUsageDetails(input: UsageDetails): UsageDetails {
  const out: Record<string, number | string> = {}
  for (const key of ['seconds', 'bytes', 'files', 'durationMs', 'results', 'status'] as const) {
    const n = input[key]
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0)
      out[key] = Math.min(n, Number.MAX_SAFE_INTEGER)
  }
  if (typeof input.query === 'string')
    out.query = input.query.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300)
  for (const key of ['mode', 'outcome', 'scope'] as const)
    if (typeof input[key] === 'string' && /^[a-z_]{1,40}$/.test(input[key]!)) out[key] = input[key]!
  return out
}
