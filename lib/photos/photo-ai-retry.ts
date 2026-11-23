/** Honor provider Retry-After without allowing an unbounded timer or invalid date. */
export function photoAiRetryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 300
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value)
    : (Date.parse(value) - now) / 1000
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(86400, Math.ceil(seconds)) : 300
}
