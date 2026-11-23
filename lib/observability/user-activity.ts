import { isActivityPath } from './activity-path'
import { withServiceDatabase } from '../database/database-context'
import { cleanUsageDetails, type UsageDetails } from '@/lib/costs/usage-details'
import { createHash, randomUUID } from 'node:crypto'
import { pgQuery, pgTransaction } from '@/lib/postgres'
import { HttpError } from '@/lib/http'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export interface ViewEvent {
  id: string
  path: string
  kind?: 'video_started' | 'video_watch' | 'video_error'
  seconds?: number
}
export function parseViews(value: unknown): ViewEvent[] {
  if (!Array.isArray(value) || value.length > 20) throw new HttpError(400, 'Invalid activity batch')
  return value.map((v) => {
    if (!v || typeof v.id !== 'string' || !UUID.test(v.id) || !isActivityPath(v.path))
      throw new HttpError(400, 'Invalid activity event')
    if (v.kind !== undefined) {
      if (
        !['video_started', 'video_watch', 'video_error'].includes(v.kind) ||
        !/^\/photos\/\d+$/.test(v.path)
      )
        throw new HttpError(400, 'Invalid video event')
      if (
        v.kind === 'video_watch' &&
        (typeof v.seconds !== 'number' ||
          !Number.isFinite(v.seconds) ||
          v.seconds <= 0 ||
          v.seconds > 60)
      )
        throw new HttpError(400, 'Invalid watch time')
      return {
        id: v.id,
        path: v.path,
        kind: v.kind,
        ...(v.kind === 'video_watch' ? { seconds: v.seconds } : {}),
      }
    }
    return { id: v.id, path: v.path }
  })
}
export async function recordViews(username: string, requestedSession: string, views: ViewEvent[]) {
  return pgTransaction(async () => {
    await pgQuery("SET LOCAL statement_timeout = '1500ms'")
    // Serialize a session's retries/tabs. A client can never attach activity to another identity.
    await pgQuery('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [requestedSession])
    const rows = await pgQuery<{ session_id: string }>(
      `SELECT session_id FROM user_activity_sessions WHERE session_id=$1 AND username=$2 AND last_seen > now()-interval '30 minutes'`,
      [requestedSession, username],
    )
    const session = rows[0]?.session_id ?? randomUUID()
    await pgQuery(
      `INSERT INTO user_activity_sessions(session_id,username) VALUES($1,$2) ON CONFLICT(session_id) DO UPDATE SET last_seen=now()`,
      [session, username],
    )
    if (!rows.length)
      await pgQuery(
        `INSERT INTO user_activity_events(event_id,username,session_id,kind,source) VALUES($1,$2,$3,'app_visit','server')`,
        [randomUUID(), username, session],
      )
    for (const v of views) {
      const kind =
        v.kind ??
        (/^\/photos\/\d+$/.test(v.path)
          ? 'photo_view'
          : /^\/events\/\d+$/.test(v.path)
            ? 'album_view'
            : 'page_view')
      await pgQuery(
        `INSERT INTO user_activity_events(event_id,username,session_id,kind,target,source,details) VALUES($1,$2,$3,$4,$5,'browser',$6::jsonb) ON CONFLICT(event_id) DO NOTHING`,
        [
          v.id,
          username,
          session,
          kind,
          v.path,
          JSON.stringify(v.kind === 'video_watch' ? { seconds: v.seconds } : {}),
        ],
      )
    }
    return session
  })
}
export async function recordAction(
  username: string,
  kind: string,
  target: string,
  details: UsageDetails = {},
  key?: string,
) {
  const hex = key
    ? createHash('sha256')
        .update(JSON.stringify([username, kind, key]))
        .digest('hex')
        .slice(0, 32)
    : null
  const id = hex
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`
    : randomUUID()
  await pgQuery(
    `INSERT INTO user_activity_events(event_id,username,kind,target,source,details) VALUES($1,$2,$3,$4,'server',$5::jsonb) ON CONFLICT(event_id) DO NOTHING`,
    [id, username, kind, target, JSON.stringify(cleanUsageDetails(details))],
  )
}
export async function activityReport(
  username: string,
  kind: string,
  days = 30,
  before?: { time: string; id: string },
) {
  const params = [username, kind, days]
  const where =
    "occurred_at >= now()-($3::int*interval '1 day') AND ($1='' OR username=$1) AND ($2='' OR kind=$2)"
  const totals = await pgQuery(
    `SELECT count(DISTINCT username)::int AS users,
 count(*) FILTER(WHERE kind='app_visit')::int AS visits,
 count(*) FILTER(WHERE kind='photo_view')::int AS photos,
 count(*) FILTER(WHERE kind='album_view')::int AS albums,
 count(*) FILTER(WHERE kind='video_started')::int AS video_starts,
 COALESCE(sum((details->>'seconds')::numeric) FILTER(WHERE kind='video_watch'),0)::float8 AS watch_seconds,
 count(*) FILTER(WHERE kind='search_performed')::int AS searches,
 count(*) FILTER(WHERE kind='search_performed' AND details->>'outcome'='failed')::int AS search_failures,
 count(*) FILTER(WHERE kind='search_performed' AND details->>'mode'='semantic')::int AS semantic_searches,
 count(*) FILTER(WHERE kind='search_performed' AND details->>'outcome'='success' AND details->>'results'='0')::int AS empty_searches,
 COALESCE(avg((details->>'durationMs')::numeric) FILTER(WHERE kind='search_performed'),0)::float8 AS search_ms,
 count(*) FILTER(WHERE kind='upload_started')::int AS uploads_started,
 count(*) FILTER(WHERE kind='upload_completed' AND details->>'outcome'='success')::int AS uploads_saved,
 count(*) FILTER(WHERE kind='upload_completed' AND details->>'outcome'='skipped')::int AS uploads_skipped,
 count(*) FILTER(WHERE kind='upload_failed')::int AS upload_failures,
 COALESCE(sum((details->>'bytes')::numeric) FILTER(WHERE kind='upload_completed' AND details->>'outcome'='success'),0)::float8 AS upload_bytes,
 count(*) FILTER(WHERE kind='download_requested')::int AS downloads,
 COALESCE(sum((details->>'files')::numeric) FILTER(WHERE kind='download_requested'),0)::float8 AS download_files,
 COALESCE(sum((details->>'bytes')::numeric) FILTER(WHERE kind='download_requested'),0)::float8 AS download_bytes
 FROM user_activity_events WHERE ${where}`,
    params,
  )
  const active = await pgQuery(
    `SELECT count(DISTINCT username)::int AS active FROM user_activity_sessions WHERE last_seen>now()-interval '5 minutes' AND ($1='' OR username=$1)`,
    [username],
  )
  const daily = await pgQuery(
    `SELECT to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,count(DISTINCT username)::int AS users,count(*)::int AS events FROM user_activity_events WHERE ${where} GROUP BY 1 ORDER BY 1`,
    params,
  )
  const events = await pgQuery<{
    username: string
    event_id: string
    occurred_at: Date
    cursor_time: string
  }>(
    `SELECT event_id,username,kind,target,source,occurred_at,details,
       to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
     FROM user_activity_events
     WHERE ${where} ${before ? 'AND (occurred_at,event_id)<($4::timestamptz,$5::uuid)' : ''}
     ORDER BY occurred_at DESC,event_id DESC
     LIMIT 101`,
    before ? [...params, before.time, before.id] : params,
  )
  const more = events.length > 100
  const page = events.slice(0, 100)
  const last = page.at(-1)
  const users = await pgQuery<{ username: string; events: number; last_seen: string }>(
    `SELECT username,count(*)::int AS events,max(occurred_at) AS last_seen FROM user_activity_events WHERE ${where} GROUP BY username ORDER BY last_seen DESC LIMIT 200`,
    params,
  )
  const labeled = new Map(
    (await activityIdentities([...users, ...page])).map((row) => [
      row.username,
      { displayName: row.displayName, email: row.email },
    ]),
  )
  return {
    totals: { ...totals[0], ...active[0] },
    daily,
    events: page.map((row) => ({ ...row, ...labeled.get(row.username)! })),
    users: users.map((row) => ({ ...row, ...labeled.get(row.username)! })),
    next: more && last ? { time: last.cursor_time, id: last.event_id } : null,
  }
}

export async function cleanupActivity() {
  return withServiceDatabase(() =>
    pgTransaction(async () => {
      const cleanup = await pgQuery(
        `INSERT INTO user_activity_maintenance(id,cleaned_at) VALUES(1,now()) ON CONFLICT(id) DO UPDATE SET cleaned_at=now() WHERE user_activity_maintenance.cleaned_at<now()-interval '1 day' RETURNING id`,
      )
      if (cleanup.length) {
        await pgQuery("DELETE FROM user_activity_events WHERE occurred_at<now()-interval '90 days'")
        await pgQuery(
          "DELETE FROM user_activity_daily WHERE day < (now() AT TIME ZONE 'UTC')::date-interval '12 months'",
        )
        await pgQuery("DELETE FROM user_activity_sessions WHERE last_seen<now()-interval '90 days'")
      }
    }),
  )
}

export async function activityIdentities<T extends { username: string }>(rows: T[]) {
  const names = [...new Set(rows.map((row) => String(row.username)))]
  const profiles = names.length
    ? await pgQuery<{ name: string; display_name: string | null; email: string | null }>(
        `SELECT name,display_name,email FROM deleted_accounts WHERE name=ANY($1::text[])
         UNION ALL SELECT name,display_name,email FROM gallery_access_objects
         WHERE kind='user' AND name=ANY($1::text[])`,
        [names],
      )
    : []
  const identities = new Map(profiles.map((profile) => [profile.name, profile]))
  const withIdentity = (row: T) => {
    const name = String(row.username)
    const profile = identities.get(name)
    return {
      ...row,
      displayName:
        profile?.display_name?.trim() ||
        profile?.email?.trim() ||
        (/^U_[a-f0-9]+$/i.test(name) ? 'Former member' : name),
      email: profile?.email?.trim() || null,
    }
  }
  return rows.map(withIdentity)
}
