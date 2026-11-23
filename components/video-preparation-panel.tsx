'use client'
import { isVideoPreparationStatus } from '@/lib/process-status-contracts'
import { BatchHelp, BatchProgress } from './batch-progress'
import { processIsActive } from '@/lib/status-polling'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useProcessStatus } from './use-process-status'
import { readClientResponse } from '@/lib/client-response'
import { preparationRetryMessage } from '@/lib/video/video-retry-message'

type Data = {
  retries?: {
    photo_id: number
    source_filename: string
    status: string
    attempts: number
    next_attempt_at: string
    error: string
  }[]
  statusWarning?: string | null
  summary: { total: number; ready: number; pending: number; skipped: number }
  run: {
    id: string
    status: string
    total: number
    created_at: string
    idle_since?: string | null
    finished_at: string | null
    error: string | null
  } | null
  progress: {
    ready: number
    running: number
    queued: number
    failed: number
    skipped: number
  } | null
  excluded: { photo_id: number; source_filename: string }[]
  failures: { photo_id: number; source_filename: string; error: string }[]
}
const isData = (value: unknown): value is Data => isVideoPreparationStatus(value)
export function VideoPreparationPanel({ automatic = false }: { automatic?: boolean }) {
  const { data, error, setError, refreshing, updated, load, refreshAfterMutation } =
    useProcessStatus<Data>(
      '/api/admin/video-preparation',
      'Unable to refresh preparation',
      (value) => processIsActive(value.run?.status),
      isData,
    )
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [saving, setSaving] = useState<number | null>(null)
  const active = !!data?.run && ['starting', 'running'].includes(data.run.status)
  useEffect(() => {
    if (!active && !busy) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active, busy])
  async function start() {
    setBusy(true)
    setError('')
    try {
      const r = await fetch('/api/admin/video-preparation', {
        method: 'POST',
        signal: AbortSignal.timeout(90000),
      })
      await readClientResponse(r, 'Unable to start preparation. Please retry.')
      await refreshAfterMutation()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to start preparation')
    } finally {
      setBusy(false)
    }
  }
  async function setSkipped(photoId: number, skipped: boolean) {
    setSaving(photoId)
    setError('')
    try {
      const r = await fetch('/api/admin/video-preparation', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoId, skipped }),
        signal: AbortSignal.timeout(45000),
      })
      await readClientResponse(r, 'Unable to change exclusion. Please retry.')
      await refreshAfterMutation()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to change exclusion')
    } finally {
      setSaving(null)
    }
  }
  const elapsed = data?.run
    ? Math.max(
        0,
        Math.floor(
          ((data.run.finished_at ? new Date(data.run.finished_at).getTime() : now) -
            new Date(data.run.created_at).getTime()) /
            1000,
        ),
      )
    : 0
  return (
    <section className="surface-panel p-5 space-y-3">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <h2 className="font-semibold">Video playback</h2>
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
          ? 'New videos are prepared automatically for smooth playback. Originals stay unchanged. AI video descriptions remain manual.'
          : 'Prepare smooth playback versions for videos. Originals stay unchanged.'}
      </BatchHelp>
      {data?.statusWarning && (
        <p role="alert" className="text-sm">
          {data.statusWarning}
        </p>
      )}
      {data && (
        <>
          <p className="text-sm">
            <strong>{data.summary.ready}</strong> ready · <strong>{data.summary.pending}</strong>{' '}
            need preparation{data.summary.skipped > 0 && <> · {data.summary.skipped} excluded</>} ·{' '}
            {data.summary.total} total
          </p>
          <BatchProgress
            status={
              active
                ? data.run?.idle_since
                  ? 'Ready for new uploads'
                  : data.run?.status === 'starting'
                    ? 'Starting worker'
                    : data.progress?.running === 0 && data.retries?.length
                      ? 'Waiting to retry'
                      : 'Preparing'
                : data.run?.status === 'failed'
                  ? 'Needs attention'
                  : data.summary.pending
                    ? 'Ready to prepare'
                    : 'Up to date'
            }
            done={
              data.run && data.progress
                ? data.progress.ready + data.progress.skipped
                : data.summary.ready + data.summary.skipped
            }
            total={data.run && data.progress ? data.run.total : data.summary.total}
            unit="videos ready or excluded"
            updated={updated}
            elapsed={data.run ? elapsed : undefined}
            metrics={[
              { label: 'Processing', value: data.progress?.running ?? 0 },
              { label: 'Waiting', value: data.progress?.queued ?? data.summary.pending },
              { label: 'Failed', value: data.progress?.failed ?? 0 },
            ]}
          />
          {data.run?.error && (
            <p role="alert" className="text-sm text-destructive">
              {data.run.error}
            </p>
          )}
          {!!data.retries?.length && (
            <details className="text-sm">
              <summary className="cursor-pointer py-2">
                Waiting to retry ({data.retries.length})
              </summary>
              {data.retries.map((r) => (
                <p key={r.photo_id}>
                  {r.source_filename}: {preparationRetryMessage(r, now)}
                </p>
              ))}
            </details>
          )}
          {(!automatic || (!active && data.summary.pending > 0)) && (
            <button
              className="control btn-primary"
              disabled={saving !== null || busy || !data.summary.pending || active}
              onClick={start}
            >
              {busy
                ? 'Starting…'
                : data.run?.status === 'starting'
                  ? 'Starting…'
                  : data.run?.status === 'running'
                    ? 'Preparation running'
                    : automatic
                      ? 'Retry unfinished videos'
                      : 'Prepare videos'}
            </button>
          )}
          {!data.summary.pending && (
            <p className="text-sm text-muted-foreground">
              {data.summary.skipped
                ? 'All remaining videos are ready. Excluded originals are unchanged.'
                : 'All videos are ready.'}{' '}
              The GPU will not start.
            </p>
          )}
          {data.failures.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm">
                Failed videos ({data.failures.length})
              </summary>
              <ul className="mt-2 space-y-2 text-sm">
                {data.failures.map((f) => (
                  <li key={f.photo_id}>
                    <Link className="underline" href={`/photos/${f.photo_id}`}>
                      {f.source_filename}
                    </Link>
                    <p className="text-muted-foreground break-words">{f.error}</p>
                    {f.error?.includes('no decoder found') && (
                      <p className="text-sm">
                        A track in this file cannot be decoded. You can exclude it from future
                        preparation attempts.
                      </p>
                    )}
                    <button
                      className="control mt-2"
                      disabled={active || busy || saving !== null}
                      onClick={() => setSkipped(f.photo_id, true)}
                    >
                      {saving === f.photo_id ? 'Saving…' : 'Don’t process'}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="text-sm mt-2">Retry unfinished videos includes failed files.</p>
            </details>
          )}
          {data.excluded?.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm">
                Excluded videos ({data.summary.skipped})
              </summary>
              <p className="text-sm mt-2">
                These originals stay in your library and will not be prepared. Allow processing to
                include one in your next run.
              </p>
              <ul className="mt-2 space-y-2 text-sm">
                {data.excluded.map((f) => (
                  <li key={f.photo_id} className="flex flex-wrap items-center gap-3">
                    <Link className="underline" href={`/photos/${f.photo_id}`}>
                      {f.source_filename}
                    </Link>
                    <button
                      className="control"
                      disabled={active || busy || saving !== null}
                      onClick={() => setSkipped(f.photo_id, false)}
                    >
                      {saving === f.photo_id ? 'Saving…' : 'Allow processing'}
                    </button>
                  </li>
                ))}
              </ul>
              {data.summary.skipped > data.excluded.length && (
                <p className="text-sm">Showing the latest {data.excluded.length} exclusions.</p>
              )}
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
