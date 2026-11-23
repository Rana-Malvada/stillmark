import { pgQuery } from '@/lib/postgres'
import { HttpError, integer } from '@/lib/http'

export function exportFilters(req: Request) {
  const q = new URL(req.url).searchParams
  const user = q.get('user') ?? ''
  const kind = q.get('kind') ?? ''
  const mode = q.get('mode') ?? 'details'
  if (user.length > 255 || !/^[a-z_]{0,50}$/.test(kind) || !['details', 'summary'].includes(mode))
    throw new HttpError(400, 'Invalid report filters')
  return {
    user,
    kind,
    mode,
    days: integer(
      q.get('days') ?? (mode === 'summary' ? 366 : 30),
      'days',
      1,
      mode === 'summary' ? 366 : 90,
    ),
  }
}
export function csvCell(value: unknown) {
  let s =
    value == null
      ? ''
      : value instanceof Date
        ? value.toISOString()
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value)
  // Neutralize spreadsheet formulas even after leading whitespace/control characters.
  if (/^[\s\x00-\x1f]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s
  return '"' + s.replaceAll('"', '""') + '"'
}
export function toCsv(rows: Record<string, unknown>[], columns: string[]) {
  return (
    '\ufeff' +
    [
      columns.map(csvCell).join(','),
      ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')),
    ].join('\r\n') +
    '\r\n'
  )
}
export async function summaryReport(user: string, kind: string, days = 366, limit = 1001) {
  return pgQuery(
    `SELECT day::text,username,kind,provider,events::float8,seconds::float8,bytes::float8,files::float8,successes::float8,failures::float8,skipped::float8,duration_ms::float8,results::float8
 FROM user_activity_daily
 WHERE day >= (now() AT TIME ZONE 'UTC')::date-($3::int-1)
 AND day >= (now() AT TIME ZONE 'UTC')::date-interval '12 months'
 AND ($1='' OR username=$1)
 AND ($2='' OR kind=$2)
 ORDER BY day DESC,username,kind,provider
 LIMIT $4`,
    [user, kind, days, limit],
  )
}
export async function exportActivity(filters: ReturnType<typeof exportFilters>) {
  const { user, kind, days, mode } = filters
  const rows =
    mode === 'summary'
      ? await summaryReport(user, kind, days, 50001)
      : await pgQuery(
          `SELECT occurred_at,username,kind,target,source,details
           FROM user_activity_events
           WHERE occurred_at>=now()-($3::int*interval '1 day')
           AND ($1='' OR username=$1)
           AND ($2='' OR kind=$2)
           ORDER BY occurred_at DESC,event_id DESC
           LIMIT 50001`,
          [user, kind, days],
        )
  if (rows.length > 50000)
    throw new HttpError(
      413,
      'Export exceeds 50,000 rows. Narrow the date range or user/type filters.',
    )
  return toCsv(
    rows,
    mode === 'summary'
      ? [
          'day',
          'username',
          'kind',
          'provider',
          'events',
          'seconds',
          'bytes',
          'files',
          'successes',
          'failures',
          'skipped',
          'duration_ms',
          'results',
        ]
      : ['occurred_at', 'username', 'kind', 'target', 'source', 'details'],
  )
}
