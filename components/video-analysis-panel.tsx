'use client'
import { isAnalysisStart } from '@/lib/frontend-response-contracts'
import { clientMutation } from '@/lib/client-operation'
import { SearchUpdateHint } from './processing-settings'
import { processIsActive, watchProcessStatus } from '@/lib/status-polling'
import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { ChevronDown, RotateCw, Sparkles } from 'lucide-react'
import type { VideoResult } from '@/lib/video/video-analysis-format'

type Run = {
  created_at: string
  started_at?: string
  id: string
  status: string
  phase?: string
  result?: VideoResult
  error?: string
  completed_at: string
  model: string
  compressed: boolean
  analysis_bytes: number
}
type Data = {
  canRun: boolean
  unavailable: string | null
  latest: Run | null
  completed: Run | null
}
const labels: Record<keyof Omit<VideoResult, 'tags'>, string> = {
  summary: 'Summary',
  description: 'What happens',
  language: 'Language',
  transcript: 'Original transcript',
  english_translation: 'English translation',
  speakers: 'Speakers',
  key_moments: 'Key moments',
  tone: 'Tone and observable behavior',
  limitations: 'Uncertainty and limitations',
}
export function VideoAnalysisPanel({
  photoId,
  onStarted,
}: {
  photoId: number
  onStarted?: () => void
}) {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let cancelled = false
    let pending = false
    let active = false
    const controller = new AbortController()
    const load = async () => {
      if (pending || document.hidden) return
      pending = true
      try {
        const r = await fetch(`/api/photos/${photoId}/analysis`, {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
        })
        const d = await r.json()
        if (!r.ok) throw Error(d.error || 'Cannot load analysis')
        if (cancelled) return
        active = processIsActive(d.latest?.status)
        setData(d)
        setError('')
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Cannot load analysis')
      } finally {
        pending = false
      }
    }
    void load()
    const stopPolling = watchProcessStatus(
      () => void load(),
      () => active,
    )
    return () => {
      cancelled = true
      controller.abort()
      stopPolling()
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refresh is the reload trigger after an analysis is started
  }, [photoId, refresh])
  async function run() {
    setBusy(true)
    setError('')
    try {
      await clientMutation(
        `/api/photos/${photoId}/analysis`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rerun: !!data?.completed }),
        },
        'Could not start analysis',
        isAnalysisStart,
        () => setRefresh((v) => v + 1),
      )
      onStarted?.()
      setConfirm(false)
      setRefresh((v) => v + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start analysis')
    } finally {
      setBusy(false)
    }
  }
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!['queued', 'running'].includes(data?.latest?.status || '')) return
    // oxlint-disable-next-line react/set-state-in-effect -- the clock must be resynchronised the moment a run becomes active; waiting for the first tick would show a stale elapsed time for a second
    setNow(Date.now())
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the run id restarts the clock when a new run replaces one with the same status
  }, [data?.latest?.id, data?.latest?.status])
  const elapsed = Math.max(
    0,
    Math.floor(
      (now -
        Date.parse(
          data?.latest?.started_at || data?.latest?.created_at || new Date(now).toISOString(),
        )) /
        1000,
    ),
  )
  const elapsedText = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
  const active = ['queued', 'running'].includes(data?.latest?.status || '')
  const result = data?.completed?.result
  return (
    <section className="my-4 space-y-3 text-sm break-words" aria-label="Video analysis">
      <h3 className="font-semibold">Video analysis</h3>
      {error && (
        <p role="alert" className="text-destructive">
          {error}{' '}
          <Button
            variant="outline"
            className="min-h-11 cursor-pointer"
            onClick={() => setRefresh((v) => v + 1)}
          >
            Retry
          </Button>
        </p>
      )}
      {!data && !error && <p>Loading analysis…</p>}
      {active && (
        <p role="status" className="text-primary">
          {data?.latest?.status === 'queued'
            ? 'Queued for analysis'
            : data?.latest?.phase === 'preparing'
              ? 'Preparing video for analysis…'
              : 'Analyzing video…'}{' '}
          <span aria-live="off" className="font-mono tabular-nums">
            {elapsedText} elapsed
          </span>
          . You can leave this page.
        </p>
      )}
      {data?.latest?.status === 'failed' && (
        <p role="alert" className="text-warning">
          {data.latest.error}
        </p>
      )}
      {data && !result && !active && (
        <p className="text-muted-foreground">No saved analysis yet.</p>
      )}
      {data?.canRun && !active && (
        <>
          {data.unavailable ? (
            <p>{data.unavailable}</p>
          ) : confirm ? (
            <div className="rounded border border-border p-3 space-y-2">
              <p>
                Analyze this video with Gemini? This uses paid Snowflake AI processing. Large videos
                use a temporary smaller copy; the original stays unchanged.
                {result ? ' The previous result stays available until the new run succeeds.' : ''}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  className="min-h-11 cursor-pointer"
                  disabled={busy}
                  onClick={() => void run()}
                >
                  <Sparkles className="size-4" />
                  {busy ? 'Starting…' : 'Run analysis'}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  className="min-h-11 cursor-pointer"
                  onClick={() => setConfirm(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button className="min-h-11 cursor-pointer" onClick={() => setConfirm(true)}>
              {result ? <RotateCw className="size-4" /> : <Sparkles className="size-4" />}
              {result ? 'Run again' : 'Analyze video'}
            </Button>
          )}
        </>
      )}
      {result && (
        <>
          <p className="text-xs text-muted-foreground">
            {data?.completed?.model} · {new Date(data!.completed!.completed_at).toLocaleString()}
            {data?.completed?.compressed ? ' · Analyzed a compressed copy' : ''}. AI-generated;
            details and timestamps may be inaccurate.
          </p>
          {(Object.keys(labels) as (keyof typeof labels)[]).map((k) => (
            <details
              key={k}
              open={k === 'summary'}
              className="group rounded-lg border border-border overflow-hidden"
            >
              <summary className="flex min-h-11 items-center justify-between gap-2 cursor-pointer list-none bg-secondary/60 px-3 py-2 font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
                <span>{labels[k]}</span>
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 shrink-0 text-primary transition-transform group-open:rotate-180"
                />
              </summary>
              <p className="whitespace-pre-wrap px-3 py-3">{result[k] || 'Not available'}</p>
            </details>
          ))}
          <p className="text-xs">{result.tags.join(' · ')}</p>
          {data?.canRun && (
            <p className="text-xs text-muted-foreground">
              <SearchUpdateHint />
            </p>
          )}
        </>
      )}
    </section>
  )
}
