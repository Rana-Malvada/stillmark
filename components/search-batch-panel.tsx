'use client'
import { BatchHelp, BatchProgress } from './batch-progress'
import { processIsActive } from '@/lib/status-polling'
import { useEffect, useRef, useState } from 'react'
import { useProcessStatus } from './use-process-status'
import { readClientResponse } from '@/lib/client-response'
import { isSearchBatchStatus, type SearchBatchStatus } from '@/lib/search/search-batch-status'

export function SearchBatchPanel({
  readOnly,
  automatic = false,
}: {
  readOnly: boolean
  automatic?: boolean
}) {
  const { data, error, setError, refreshing, load, refreshAfterMutation } =
    useProcessStatus<SearchBatchStatus>(
      '/api/admin/search-batch',
      'Search status unavailable. Please retry.',
      (value) =>
        !!value.pipeline?.active ||
        processIsActive(value.run?.status) ||
        value.automaticPublishing?.status === 'running',
      isSearchBatchStatus,
    )
  const [mutating, setMutating] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const busy = mutating || refreshing
  const [photos, setPhotos] = useState('100000')
  const [searches, setSearches] = useState('20')
  async function request(body?: Record<string, unknown>) {
    if (body && inFlight.current) return
    if (body) {
      inFlight.current = true
      setMutating(true)
    }
    setError('')
    try {
      if (body) {
        const response = await fetch('/api/admin/search-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90000),
        })
        await readClientResponse(response, 'Unable to change search processing. Please retry.')
        await refreshAfterMutation()
      } else await load()
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Search batch unavailable')
    } finally {
      if (body) {
        inFlight.current = false
        if (mounted.current) setMutating(false)
      }
    }
  }
  useEffect(() => {
    mounted.current = true
    const refresh = () => {
      if (!document.hidden)
        void load().catch((e: unknown) =>
          setError(e instanceof Error ? e.message : 'Search batch unavailable'),
        )
    }
    window.addEventListener('gallery-upload-complete', refresh)
    return () => {
      mounted.current = false
      window.removeEventListener('gallery-upload-complete', refresh)
    }
  }, [load, setError])
  return (
    <section className="surface-panel p-6 space-y-3">
      <h2 className="font-semibold">Search progress</h2>
      <BatchHelp>
        {automatic
          ? 'New photos are enriched and search updates are published automatically. Updates continue when you leave this page, with a three-hour limit per cycle. Completed work is saved.'
          : 'Process pending OCR, visual embeddings and saved search rankings. The complete update has a three-hour limit. Completed work is saved.'}
      </BatchHelp>
      {(!automatic ||
        (!!data?.summary.pending &&
          !data.pipeline?.active &&
          !processIsActive(data.run?.status))) && (
        <details className="text-sm">
          <summary className="cursor-pointer py-2">Recovery settings</summary>
          <div className="flex flex-wrap gap-4 py-3">
            <label>
              Maximum photos{' '}
              <input
                className="control w-24"
                type="number"
                min="0"
                max="100000"
                value={photos}
                onChange={(e) => setPhotos(e.target.value)}
              />
            </label>
            <label>
              Maximum searches{' '}
              <input
                className="control w-24"
                type="number"
                min="0"
                max="1000"
                value={searches}
                onChange={(e) => setSearches(e.target.value)}
              />
            </label>
          </div>
          {(data?.summary.pending ?? 0) > 0 && !data?.pipeline?.active && (
            <button
              className="control"
              disabled={busy || readOnly}
              onClick={() => setPhotos(String(Math.min(100000, data?.summary.pending ?? 0)))}
            >
              Set photo limit to pending count ({data?.summary.pending})
            </button>
          )}
        </details>
      )}
      <div className="flex flex-wrap gap-3">
        {(!automatic ||
          (!!data?.summary.pending &&
            !data.pipeline?.active &&
            !processIsActive(data.run?.status))) && (
          <button
            className="control"
            disabled={
              busy ||
              !data ||
              !!data.pipeline?.active ||
              processIsActive(data.run?.status) ||
              readOnly ||
              photos.trim() === '' ||
              searches.trim() === '' ||
              !Number.isInteger(Number(photos)) ||
              !Number.isInteger(Number(searches)) ||
              Number(photos) < 0 ||
              Number(photos) > 100000 ||
              Number(searches) < 0 ||
              Number(searches) > 1000
            }
            onClick={() => request({ photoLimit: Number(photos), searchLimit: Number(searches) })}
          >
            {automatic ? 'Retry unfinished work' : 'Run batch'}
          </button>
        )}
        <button className="control" disabled={busy} onClick={() => request()}>
          Refresh status
        </button>
        {data?.pipeline?.canRetryFollowup && (
          <button
            className="control"
            disabled={busy || readOnly}
            onClick={() => request({ action: 'retry-followup', id: data.pipeline?.rootId })}
          >
            Retry follow-up
          </button>
        )}
        {(data?.pipeline?.canStop || data?.automaticPublishing?.status === 'running') && (
          <button
            className="control"
            disabled={busy || readOnly}
            onClick={() => request({ action: 'stop' })}
          >
            Stop
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {!data && !error && (
        <p className="text-sm text-muted-foreground" role="status">
          Loading status…
        </p>
      )}
      {data && (
        <div className="space-y-4">
          <BatchProgress
            status={
              data.warmIdle
                ? 'Ready for new uploads'
                : data.automaticPublishing?.status === 'running'
                  ? 'Publishing search'
                  : data.pipeline?.active
                    ? data.pipeline.stage === 0
                      ? 'Enriching photos'
                      : data.pipeline.stage === 1
                        ? 'Publishing search'
                        : 'Ranking searches'
                    : data.pipeline?.status === 'failed'
                      ? 'Needs attention'
                      : data.summary.pending
                        ? 'Photos remaining'
                        : data.summary.failed
                          ? 'Needs attention'
                          : 'Up to date'
            }
            done={
              data.pipeline && data.pipeline.photoLimit > 0
                ? data.pipeline.photosDone
                : data.summary.completed
            }
            total={
              data.pipeline && data.pipeline.photoLimit > 0
                ? data.pipeline.photoLimit
                : data.summary.completed +
                  data.summary.pending +
                  data.summary.failed +
                  (data.summary.running ?? 0)
            }
            unit={
              data.pipeline && data.pipeline.photoLimit > 0
                ? 'photos enriched in this batch'
                : 'photos enriched'
            }
            updated={data.checkedAt}
            metrics={[
              { label: 'Processing', value: data.summary.running ?? 0 },
              { label: 'Waiting', value: data.summary.pending },
              { label: 'Failed', value: data.summary.failed },
            ]}
          >
            <ol
              aria-label="Search update stages"
              className="flex flex-wrap gap-3 text-xs sm:text-sm"
            >
              {['Enrich', 'Publish', 'Rank'].map((label, index) => (
                <li
                  key={label}
                  aria-current={data.pipeline?.stage === index ? 'step' : undefined}
                  className={
                    data.pipeline?.stage === index
                      ? 'text-primary font-semibold'
                      : 'text-muted-foreground'
                  }
                >
                  {index + 1} · {label}
                </li>
              ))}
            </ol>
          </BatchProgress>
          {data.automaticPublishing?.error && (
            <div>
              <p role="alert" className="text-sm text-destructive">
                {data.automaticPublishing.error}
              </p>
              <button
                className="control mt-2"
                disabled={busy || readOnly}
                onClick={() => request({ action: 'retry-publishing' })}
              >
                Retry search publishing
              </button>
            </div>
          )}
          {data.pipeline && !data.warmIdle && (
            <p
              role="status"
              className={
                data.pipeline.status === 'failed'
                  ? 'text-sm text-destructive'
                  : 'text-sm text-muted-foreground'
              }
            >
              {data.pipeline.message}
            </p>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer py-2">Run details</summary>
            <div className="space-y-2 text-muted-foreground">
              <p>
                {data.summary.completed} enriched across the library · {data.searches.pending}{' '}
                searches queued
              </p>
              {data.pipeline && (
                <p>
                  {data.pipeline.photosDone} photos processed · {data.pipeline.searchesDone}{' '}
                  searches processed · {data.pipeline.failures} failures
                </p>
              )}
              <p>
                Counts refresh while running and after uploads in this browser. Refresh status for
                changes from other devices.
              </p>
              <p>
                {data.rankingEnabled
                  ? 'Validated batch rankings are enabled.'
                  : 'Batch rankings are evaluated before activation.'}
              </p>
            </div>
          </details>
        </div>
      )}
    </section>
  )
}
