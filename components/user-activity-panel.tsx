'use client'
import { isRecord } from '@/lib/frontend-response-contracts'
import { clientOperation } from '@/lib/client-operation'
import { MobileActivityCards } from './mobile-activity-cards'
import { useEffect, useEffectEvent, useState } from 'react'
import type { UsageDetails } from '@/lib/costs/usage-details'
import { IdentityActivityPanel } from './identity-activity-panel'

type ActivityUser = {
  username: string
  displayName: string
  email: string | null
  events: number
  last_seen: string
}
function userLabel(user: { displayName: string; email: string | null }) {
  return user.email && user.email !== user.displayName
    ? `${user.displayName} · ${user.email}`
    : user.displayName
}
type Cursor = { time: string; id: string }
interface Report {
  totals: Record<string, number>
  daily: { day: string; users: number; events: number }[]
  users: ActivityUser[]
  next: Cursor | null
  events: {
    event_id: string
    username: string
    displayName: string
    email: string | null
    kind: string
    target: string | null
    source: string
    occurred_at: string
    details: UsageDetails
  }[]
}
function isReport(value: unknown): value is Report {
  const text = (v: unknown) => typeof v === 'string'
  const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
  const identity = (v: unknown) =>
    isRecord(v) && text(v.username) && text(v.displayName) && (v.email === null || text(v.email))
  const details = (v: unknown) =>
    isRecord(v) &&
    ['seconds', 'bytes', 'files', 'durationMs', 'results', 'status'].every(
      (k) => v[k] === undefined || number(v[k]),
    ) &&
    ['provider', 'code', 'method', 'query', 'mode', 'outcome', 'scope'].every(
      (k) => v[k] === undefined || text(v[k]),
    )
  return (
    isRecord(value) &&
    isRecord(value.totals) &&
    Object.values(value.totals).every(number) &&
    Array.isArray(value.users) &&
    value.users.every((v) => identity(v) && isRecord(v) && number(v.events) && text(v.last_seen)) &&
    Array.isArray(value.daily) &&
    value.daily.every((v) => isRecord(v) && text(v.day) && number(v.users) && number(v.events)) &&
    Array.isArray(value.events) &&
    value.events.every(
      (v) =>
        identity(v) &&
        isRecord(v) &&
        ['event_id', 'kind', 'source', 'occurred_at'].every((k) => text(v[k])) &&
        (v.target === null || text(v.target)) &&
        details(v.details),
    ) &&
    (value.next === null || (isRecord(value.next) && text(value.next.time) && text(value.next.id)))
  )
}
const kinds = [
  'login_success',
  'login_failure',
  'identity_import',
  'app_visit',
  'page_view',
  'album_view',
  'photo_view',
  'video_started',
  'video_watch',
  'video_error',
  'search_performed',
  'upload_started',
  'upload_completed',
  'upload_failed',
  'download_requested',
  'favorite_changed',
  'photo_trashed',
  'cover_changed',
  'labels_changed',
  'people_changed',
  'album_changed',
  'album_trashed',
  'bulk_action',
]
function bytes(n: number) {
  return `${(n / 1048576).toFixed(1)} MiB`
}
function details(d: UsageDetails) {
  return [
    d.provider,
    d.method,
    d.code,
    d.query !== undefined ? `“${d.query}”` : null,
    d.mode,
    d.outcome,
    d.results !== undefined ? `${d.results} results` : null,
    d.durationMs !== undefined ? `${d.durationMs} ms` : null,
    d.seconds !== undefined ? `${d.seconds.toFixed(1)}s watched` : null,
    d.files !== undefined ? `${d.files} files` : null,
    d.bytes !== undefined ? bytes(d.bytes) : null,
    d.status ? `HTTP ${d.status}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
export function UserActivityPanel() {
  const [data, setData] = useState<Report | null>(null)
  const [user, setUser] = useState('')
  const [kind, setKind] = useState('')
  const [days, setDays] = useState('30')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [userChoices, setUserChoices] = useState<ActivityUser[]>([])
  const [applied, setApplied] = useState({ user: '', kind: '', days: '30' })
  async function load(cursor?: Cursor, selectedUser?: string) {
    if (loading) return
    setLoading(true)
    setError('')
    const filters = cursor ? applied : { user: selectedUser ?? user, kind, days }
    try {
      const q = new URLSearchParams(filters)
      if (cursor) {
        q.set('before', cursor.time)
        q.set('beforeId', cursor.id)
      }
      const next = await clientOperation<Report>(
        '/api/user-activity?' + q,
        {},
        'Unable to load user activity. Please retry.',
        isReport,
      )
      setUserChoices((current) => [
        ...new Map([...current, ...next.users].map((u) => [u.username, u])).values(),
      ])
      setData((old) =>
        cursor && old ? { ...next, events: [...old.events, ...next.events] } : next,
      )
      setApplied(filters)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  const loadOnOpen = useEffectEvent(() => void load())
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the opening load raises the same loading flag that load() uses to refuse overlapping requests
    loadOnOpen()
  }, [])
  const cards: [string, string, ((n: number) => string)?][] = [
    ['active', 'Active · 5 min'],
    ['users', 'Users'],
    ['visits', 'App visits'],
    ['photos', 'Photo views'],
    ['albums', 'Album views'],
    ['video_starts', 'Video starts'],
    ['watch_seconds', 'Watch time', (n) => `${(n / 60).toFixed(1)} min`],
    ['searches', 'Search requests'],
    ['semantic_searches', 'Semantic searches'],
    ['empty_searches', 'Empty searches'],
    ['search_failures', 'Search failures'],
    ['search_ms', 'Avg search time', (n) => `${Math.round(n)} ms`],
    ['uploads_started', 'Files started'],
    ['uploads_saved', 'Files saved'],
    ['uploads_skipped', 'Duplicates skipped'],
    ['upload_failures', 'Uploads with processing failures'],
    ['upload_bytes', 'Bytes saved', bytes],
    ['downloads', 'Download requests'],
    ['download_files', 'Files requested'],
    ['download_bytes', 'Original bytes requested', bytes],
  ]
  return (
    <main className="w-full min-w-0 px-5 sm:px-8 py-5 space-y-4">
      <h1 className="page-title">User Activity</h1>
      <p className="text-sm text-muted-foreground">
        App visits are gallery sessions, not Auth0 sign-ins. Watch time is approximate foreground
        playback time. Downloads count accepted requests, not confirmed saves. No automatic refresh.
      </p>
      <form
        className="flex flex-wrap gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void load()
        }}
      >
        <select
          aria-label="User"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          className="border rounded p-2 bg-background max-w-full"
        >
          <option value="">All users</option>
          {userChoices.map((u) => (
            <option key={u.username} value={u.username}>
              {userLabel(u)}
            </option>
          ))}
        </select>
        <select
          aria-label="Activity type"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="border rounded p-2 bg-background"
        >
          <option value="">All activities</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
        <select
          aria-label="Date range"
          value={days}
          onChange={(e) => setDays(e.target.value)}
          className="border rounded p-2 bg-background"
        >
          {['1', '7', '30', '90'].map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </select>
        <button disabled={loading} className="primary-button">
          {loading ? 'Loading…' : 'Apply / Refresh'}
        </button>
      </form>
      <IdentityActivityPanel user={applied.user} kind={applied.kind} days={applied.days} />
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {data && (
        <>
          <p className="text-sm text-muted-foreground">
            Showing{' '}
            {applied.user
              ? userChoices.find((u) => u.username === applied.user)?.displayName || 'Selected user'
              : 'all users'}{' '}
            · last {applied.days} days · {applied.kind.replaceAll('_', ' ') || 'all activities'}.
            Active users ignores activity type. Upload failures can later recover; detailed
            statistics start with this release.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {cards.map(([k, label, format]) => (
              <div key={k} className="border rounded-xl p-4">
                <p className="text-muted-foreground text-sm">{label}</p>
                <p className="text-2xl">
                  {format ? format(data.totals[k] ?? 0) : (data.totals[k] ?? 0).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
          <section className="border rounded-xl p-4">
            <h2 className="text-xl mb-3">Daily usage · UTC</h2>
            {!data.daily.length ? (
              <p>No activity recorded yet.</p>
            ) : (
              data.daily.map((d) => (
                <div key={d.day} className="flex items-center gap-4 text-sm py-1">
                  <span className="w-24 shrink-0">{d.day}</span>
                  <div
                    className="bg-primary h-3 rounded"
                    style={{
                      width: `${Math.max(1, (d.events / Math.max(...data.daily.map((v) => v.events))) * 45)}%`,
                    }}
                  />
                  <span>
                    {d.users} users · {d.events} events
                  </span>
                </div>
              ))
            )}
          </section>
          <section>
            <h2 className="text-xl mb-3">Choose a user timeline</h2>
            <div className="flex flex-wrap gap-2">
              {data.users.map((u) => (
                <button
                  disabled={loading}
                  className="control max-w-full whitespace-normal break-words text-left"
                  key={u.username}
                  onClick={() => {
                    setUser(u.username)
                    void load(undefined, u.username)
                  }}
                >
                  {userLabel(u)} · {u.events} events
                </button>
              ))}
            </div>
          </section>
          <section>
            <h2 className="text-xl mb-3">
              {applied.user
                ? `${userChoices.find((u) => u.username === applied.user)?.displayName || 'Selected user'} · `
                : ''}
              Activity timeline
            </h2>
            <MobileActivityCards
              entries={data.events.map((e) => ({
                id: String(e.event_id),
                title: e.kind.replaceAll('_', ' '),
                subtitle: `${new Date(e.occurred_at).toLocaleString()} · ${userLabel(e)}`,
                fields: [
                  { label: 'Target', value: e.target },
                  { label: 'Details', value: details(e.details ?? {}) },
                  { label: 'Source', value: e.source },
                ],
              }))}
            />
            <div className="hidden sm:block overflow-auto">
              <table className="w-full text-sm text-left">
                <thead>
                  <tr>
                    {['Time', 'User', 'Activity', 'Target', 'Details', 'Source'].map((h) => (
                      <th className="p-3 border-b" key={h}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((e) => (
                    <tr key={e.event_id}>
                      {[
                        new Date(e.occurred_at).toLocaleString(),
                        userLabel(e),
                        e.kind.replaceAll('_', ' '),
                        e.target,
                        details(e.details ?? {}),
                        e.source,
                      ].map((v, j) => (
                        <td key={j} className="p-3 border-b break-words max-w-sm">
                          {v || '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.events.length && <p>No matching activity.</p>}
            {data.next && (
              <button
                disabled={loading}
                className="control mt-4"
                onClick={() => void load(data.next!)}
              >
                Load older activity
              </button>
            )}
          </section>
        </>
      )}
    </main>
  )
}
