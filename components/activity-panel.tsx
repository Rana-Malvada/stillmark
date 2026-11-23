'use client'
import { isActivityStatus } from '@/lib/process-status-contracts'
import { useProcessStatus } from './use-process-status'
import { clientMutation } from '@/lib/client-operation'
import { SearchUpdateHint } from './processing-settings'
import { operationalAlerts } from '@/lib/operational-alerts'
import { useAuth } from './auth-provider'
import Link from 'next/link'
import { useState } from 'react'

interface Data {
  summary: Record<string, number>
  asOf: string
  sync: { last_success: string | null; last_error: string | null } | null
  uploads: {
    source_filename: string
    status: string
    error_message: string
    started_at: string
    event_name: string
    event_id: number
  }[]
  failures: { photo_id: number; source_filename: string; ai_error: string; ai_attempts: number }[]
  cleanup: { path: string; attempts: number; last_error: string }[]
}
const isData = (value: unknown): value is Data => isActivityStatus(value)
export function ActivityPanel() {
  const readOnly = !useAuth().mainAdmin

  const {
    data,
    error,
    setError,
    refreshing: loading,
    load,
    refreshAfterMutation,
  } = useProcessStatus<Data>(
    '/api/activity',
    'Unable to load activity. Please try again.',
    (value) =>
      ['active_ai', 'active_uploads', 'queued_uploads', 'processing_uploads'].some(
        (key) => Number(value.summary[key]) > 0,
      ),
    isData,
  )
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const action = async (url: string, body: object) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await clientMutation(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        'Unable to complete the request. Please retry.',
        undefined,
        refreshAfterMutation,
      )
      setMessage('Request accepted. Status updates automatically.')
      await refreshAfterMutation()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }
  const labels: Record<string, string> = {
    pending_sync: 'Pending search updates',
    pending_search_removals: 'Pending search cleanup',
    active_uploads: 'Active server uploads',
    active_ai: 'AI descriptions in progress',
    pending_ai: 'Pending AI descriptions',
    cleanup_intents: 'Storage cleanup checks',
    incomplete_uploads: 'Incomplete server uploads',
    queued_uploads: 'Uploaded · waiting to process',
    processing_uploads: 'Uploads processing',
    failed_uploads: 'Upload processing failures',
    trash: 'Files in Trash',
  }
  return (
    <main className="report-page w-full min-w-0 px-5 sm:px-8 py-5 space-y-4">
      <div className="page-header">
        <div>
          <p className="eyebrow mb-1.5">Behind the collection</p>
          <h1 className="page-title">Activity</h1>
        </div>
        <button
          disabled={busy || loading}
          onClick={() => {
            setError('')
            void load().catch((e) => setError(e.message))
          }}
          className="control"
        >
          {loading ? 'Refreshing…' : error ? 'Retry' : 'Refresh status'}
        </button>
      </div>
      <p className="text-sm text-muted-foreground">
        Status updates every five seconds while uploads, upload processing or AI descriptions are
        active and this page is visible. Idle polling stops; use Refresh status to check again.
        Status reads use Postgres. Upload recovery and retries are available in the floating upload
        panel on the browser that started the upload.
      </p>
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          {data ? 'Refreshing activity…' : 'Loading activity…'}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {data && (
        <>
          {operationalAlerts(data).length > 0 && (
            <section role="alert" className="surface-panel border border-destructive p-5 space-y-2">
              <h2 className="font-semibold">Needs attention</h2>
              {operationalAlerts(data).map((a) => (
                <p key={a.code} className="text-sm">
                  {a.message}
                </p>
              ))}
            </section>
          )}
          <p className="text-xs text-muted-foreground">
            Updated {new Date(data.asOf).toLocaleString()}
          </p>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 sm:gap-4">
            {Object.entries(labels).map(([k, label]) => (
              <div className="surface-panel p-5" key={k}>
                <p className="font-display text-4xl mb-3 tabular-nums">{data.summary[k] ?? '—'}</p>
                <p className="text-xs">{label}</p>
              </div>
            ))}
          </div>
          <section className="surface-panel p-6 space-y-3">
            <h2 className="font-semibold">Search updates</h2>
            <SearchUpdateHint activity />
            <p className="text-sm">
              Last successful sync:{' '}
              {data.sync?.last_success
                ? new Date(data.sync.last_success).toLocaleString()
                : 'None recorded'}
            </p>
            {data.sync?.last_error && <p className="text-destructive">{data.sync.last_error}</p>}
            <button
              disabled={busy || readOnly}
              onClick={() => action('/api/search-sync', {})}
              className="border rounded px-3 py-2"
            >
              Sync Search
            </button>
          </section>
          <section className="space-y-2">
            <h2 className="font-semibold">AI failures and retries</h2>
            {!data.failures.length ? (
              <p className="text-sm text-muted-foreground">No failures recorded.</p>
            ) : (
              data.failures.map((f) => (
                <div key={f.photo_id} className="border rounded p-3 text-sm">
                  <Link href={`/photos/${f.photo_id}`} className="underline">
                    {f.source_filename}
                  </Link>
                  <p>{f.ai_error}</p>
                  <p>Attempts: {f.ai_attempts}</p>
                  {f.ai_attempts >= 3 ? (
                    <button
                      disabled={busy || readOnly}
                      onClick={() => action('/api/ai-categorize', { retryPhotoId: f.photo_id })}
                      className="underline"
                    >
                      Retry AI description
                    </button>
                  ) : (
                    <p>Automatic retry is scheduled.</p>
                  )}
                </div>
              ))
            )}
          </section>
          <section className="space-y-2">
            <h2 className="font-semibold">Storage cleanup failures</h2>
            <p className="text-sm text-muted-foreground">
              Cleanup checks include retained files; a queued check does not mean the file will be
              deleted.
            </p>
            {data.cleanup.map((c) => (
              <div key={c.path} className="text-sm border rounded p-3 break-all">
                {c.path}
                <p>
                  {c.last_error} · {c.attempts} attempts
                </p>
              </div>
            ))}
            {!data.cleanup.length ? (
              <p className="text-sm">No cleanup failures.</p>
            ) : (
              <button
                disabled={busy || readOnly}
                className="border rounded px-3 py-2"
                onClick={() => action('/api/activity', { action: 'retry-cleanup' })}
              >
                Retry failed cleanup
              </button>
            )}
          </section>
          <section>
            <h2 className="font-semibold mb-3">Latest 100 file results</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Album</th>
                    <th>Result</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {data.uploads.map((u, i) => (
                    <tr key={i} className="border-t">
                      <td className="py-2">{u.source_filename}</td>
                      <td>{u.event_name ?? 'Deleted album'}</td>
                      <td>
                        {u.status}
                        {u.error_message && <p className="text-xs">{u.error_message}</p>}
                      </td>
                      <td>{new Date(u.started_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  )
}
