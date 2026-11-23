// EXIF dates have no zone; exifr represents the camera's wall time with a Z suffix.
// Apply the separately recorded offset when available, rather than treating it as UTC.
export function photoCaptureDate(value: unknown, offset: unknown): string | null {
  if (!value) return null
  const raw = value instanceof Date ? value.toISOString() : String(value)
  const iso = raw.replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T')
  const wall = iso.replace(/(?:Z|[+-]\d{2}:?\d{2})$/, '')
  const zone =
    typeof offset === 'string' && /^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(offset) ? offset : null
  const date = new Date(zone ? wall + zone : /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : iso + 'Z')
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
