'use client'
import { isFaceScanStatus } from '@/lib/process-status-contracts'
import { BatchHelp, BatchProgress } from './batch-progress'
import { processIsActive } from '@/lib/status-polling'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useProcessStatus } from './use-process-status'
import { readClientResponse } from '@/lib/client-response'

type Run = {
  id: string
  status: string
  total: number
  processed: number
  failed: number
  faces_found: number
  created_at: string
  idle_since?: string | null
  finished_at: string | null
  error: string | null
}
type Data = {
  summary: {
    total: number
    scanned: number
    pending: number
    failed: number
    owners: number
  } | null
  run: Run | null
  progress: { done: number; running: number; queued: number; failed: number } | null
  failures: { photo_id: number; source_filename: string; error: string | null }[]
  statusWarning: string | null
  continuing: boolean
  estimatedMinutes: number
}

const duration = (minutes: number) =>
  minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`

const isData = (value: unknown): value is Data => isFaceScanStatus(value)
export function FaceScanPanel({ automatic = false }: { automatic?: boolean }) {
  const { data, error, setError, refreshing, updated, load, refreshAfterMutation } =
    useProcessStatus<Data>(
      '/api/admin/face-scan',
      'Unable to refresh scan status',
      (value) => processIsActive(value.run?.status) || !!value.continuing,
      isData,
    )
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const active = !!data?.run && ['starting', 'running'].includes(data.run.status)
  // A finished batch with photos left is continued automatically; keep watching.
  const watching = active || busy || !!data?.continuing
  useEffect(() => {
    const t = setInterval(() => {
      if (watching) setNow(Date.now())
    }, 1000)
    return () => clearInterval(t)
  }, [watching])

  async function act(action: 'start' | 'stop') {
    if (
      action === 'stop' &&
      !window.confirm('Stop scanning? Photos not yet scanned stay waiting for the next scan.')
    )
      return
    setBusy(true)
    setError('')
    try {
      const r = await fetch('/api/admin/face-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(90000),
      })
      await readClientResponse(r, 'Unable to change the scan. Please retry.')
      await refreshAfterMutation()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to change the scan')
    } finally {
      setBusy(false)
    }
  }

  const run = data?.run
  const elapsed = run
    ? Math.max(
        0,
        Math.floor(
          ((run.finished_at ? new Date(run.finished_at).getTime() : now) -
            new Date(run.created_at).getTime()) /
            1000,
        ),
      )
    : 0
  const summary = data?.summary
  return (
    <section className="surface-panel p-5 space-y-3">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <h2 className="font-semibold">Faces</h2>
        <button
          className="control"
          disabled={refreshing}
          onClick={() => {
            setError('')
            void load().catch((e) => setError(e.message))
          }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <BatchHelp>
        {automatic
          ? 'New photos are scanned automatically for owners who enabled People. Scanning continues when you leave this page.'
          : 'Scan photos for owners who enabled People. Scanning continues when you leave this page.'}
      </BatchHelp>
      {data?.statusWarning && (
        <p role="alert" className="text-sm">
          {data.statusWarning}
        </p>
      )}
      {data && summary && (
        <>
          <p className="text-sm">
            <strong>{summary.scanned}</strong> scanned · <strong>{summary.pending}</strong> need
            scanning · {summary.total} photos
            {summary.pending > 0 && !active && <> · about {duration(data.estimatedMinutes)}</>}
          </p>
          {summary.owners === 0 && (
            <p className="text-sm text-muted-foreground">
              No one has turned on People yet. Owners turn it on in People → Settings.
            </p>
          )}
          <BatchProgress
            status={
              active
                ? run?.idle_since
                  ? 'Ready for new uploads'
                  : run?.status === 'starting'
                    ? 'Starting scanner'
                    : 'Scanning'
                : data.continuing
                  ? 'Starting next batch'
                  : run?.status === 'failed'
                    ? 'Needs attention'
                    : summary.pending
                      ? 'Ready to scan'
                      : 'Up to date'
            }
            done={run && data.progress ? data.progress.done : summary.scanned}
            total={run && data.progress ? run.total : summary.total}
            unit={run ? 'photos scanned in this batch' : 'photos scanned'}
            updated={updated}
            elapsed={run ? elapsed : undefined}
            metrics={[
              { label: 'Processing', value: data.progress?.running ?? 0 },
              { label: 'Waiting', value: data.progress?.queued ?? summary.pending },
              { label: 'Failed', value: data.progress?.failed ?? summary.failed },
            ]}
          />
          {run?.error && !data.continuing && (
            <p role="alert" className="text-sm text-destructive">
              {run.error}
            </p>
          )}
          {run && (
            <details className="text-sm">
              <summary className="cursor-pointer py-2">Run details</summary>
              <p>
                {run.faces_found} faces found · {summary.scanned} scanned across the library ·{' '}
                {summary.pending} still need scanning
              </p>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            {(!automatic || (!active && !data.continuing && summary.pending > 0)) && (
              <button
                className="control btn-primary"
                disabled={busy || !summary.pending || active || data.continuing}
                onClick={() => act('start')}
              >
                {busy
                  ? 'Working…'
                  : active || data.continuing
                    ? 'Scan running'
                    : automatic
                      ? 'Retry unfinished photos'
                      : 'Scan photos'}
              </button>
            )}
            {active && (
              <button className="control" disabled={busy} onClick={() => act('stop')}>
                Stop
              </button>
            )}
          </div>
          {!summary.pending && summary.total > 0 && (
            <p className="text-sm text-muted-foreground">
              Every photo is scanned. The CPU will not start.
            </p>
          )}
          {data.failures.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm">
                Failed photos ({data.failures.length})
              </summary>
              <ul className="mt-2 space-y-2 text-sm">
                {data.failures.map((f) => (
                  <li key={f.photo_id}>
                    <Link className="underline" href={`/photos/${f.photo_id}`}>
                      {f.source_filename}
                    </Link>
                    {f.error && <p className="text-muted-foreground break-words">{f.error}</p>}
                  </li>
                ))}
              </ul>
              <p className="text-sm mt-2">Retry unfinished photos includes failed scans.</p>
            </details>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </section>
  )
}
