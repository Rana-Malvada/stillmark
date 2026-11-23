'use client'
import { MobileActivityCards } from './mobile-activity-cards'
import { useIdentityActivity } from './activity/use-identity-activity'
import { useAuth } from './auth-provider'

export function IdentityActivityPanel({
  user,
  kind,
  days,
}: {
  user: string
  kind: string
  days: string
}) {
  const { canManageAccess } = useAuth()
  const { status, busy, error, notice, rows, more, importErrors, run, summaries, download } =
    useIdentityActivity(user, kind, days, canManageAccess)
  return (
    <section className="surface-panel p-5 space-y-4">
      <h2 className="text-xl">Identity logs & retention</h2>
      <p className="text-sm text-muted-foreground">
        Reports and exports read saved Postgres data. Imports run only when requested. Auth0 records
        successful and failed photo-app sign-ins. App visits are tracked separately below.
      </p>
      <div className="space-y-4">
        {(['auth0'] as const).map((provider) => {
          const s = status.find((v) => v.provider === provider)
          const importError = importErrors[provider] || s?.error
          return (
            <div className="border rounded-lg p-4 space-y-2" key={provider}>
              <h3 className="font-semibold">Auth0 · photo app logins</h3>
              <p className="text-sm text-muted-foreground">
                Imports retained Stillmark successes and failures. Unresolved identities remain
                unmapped. Import before Auth0’s plan-dependent retention expires. No warehouse.
              </p>
              <p className="text-sm">
                Last completed:{' '}
                {s?.completed_at ? new Date(s.completed_at).toLocaleString() : 'Never'}
                {s?.more ? ' · More records available' : ''}
              </p>
              {importError && (
                <p role="alert" className="text-destructive text-sm">
                  {importError}
                </p>
              )}
              <button
                className="control"
                disabled={!canManageAccess || !!busy}
                onClick={() => void run(provider)}
              >
                {busy === provider ? 'Importing…' : 'Import Auth0 logs'}
              </button>
            </div>
          )
        })}
      </div>
      {!canManageAccess && (
        <p className="text-sm text-muted-foreground">
          Read-only access: imports require Access Manager permission.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Detailed events: 90 days. Daily totals: 12 months, without search text or photo targets.
        Expired rows are removed on the next active-use cleanup. Summary actions use the current
        user/type filters across 12 months.
      </p>
      <div className="flex flex-wrap gap-3">
        <button className="control" disabled={!!busy} onClick={() => void summaries()}>
          Show retained daily totals
        </button>
        <button className="control" disabled={!!busy} onClick={() => void download('details')}>
          Export filtered details · CSV
        </button>
        <button className="control" disabled={!!busy} onClick={() => void download('summary')}>
          Export 12-month totals · CSV
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {rows.length > 0 && (
        <div>
          <MobileActivityCards
            entries={rows.map((r, i) => ({
              id: String(i),
              title: `${r.kind} · ${r.displayName || 'Former member'}${r.email ? ` · ${r.email}` : ''}`,
              subtitle: `${r.day} UTC`,
              fields: ['provider', 'events', 'successes', 'failures'].map((k) => ({
                label: k,
                value: String(r[k] ?? '—'),
              })),
            }))}
          />
          <div className="hidden sm:block overflow-auto max-h-96">
            <table className="w-full text-sm text-left">
              <thead>
                <tr>
                  {[
                    'Day UTC',
                    'User',
                    'Email',
                    'Activity',
                    'Provider',
                    'Events',
                    'Successes',
                    'Failures',
                  ].map((h) => (
                    <th key={h} className="p-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {[
                      'day',
                      'displayName',
                      'email',
                      'kind',
                      'provider',
                      'events',
                      'successes',
                      'failures',
                    ].map((k) => (
                      <td key={k} className="p-2 border-t">
                        {r[k]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {more && <p>Showing 1,000 rows. Export or narrow filters for more.</p>}
        </div>
      )}
    </section>
  )
}
