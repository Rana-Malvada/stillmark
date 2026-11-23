'use client'
import type { CostRefreshProgress as Progress } from '@/lib/costs/cost-refresh-state'

export function CostRefreshProgress({ progress }: { progress: Progress | null }) {
  const checked =
    progress?.sources.filter((s) => ['complete', 'failed'].includes(s.status)).length ?? 0
  const total = progress?.sources.length ?? 0
  const failed = progress?.sources.filter((s) => s.status === 'failed').length ?? 0
  const current = progress?.sources.find((s) => s.status === 'running')
  const percent = total ? Math.floor((checked / total) * 100) : 0
  return (
    <section
      aria-label="Cost refresh progress"
      className="rounded-xl border bg-card p-4 text-sm space-y-3"
    >
      <p role="status" className="flex flex-wrap justify-between gap-2">
        <span className="font-medium">Refreshing costs…</span>
        <span className="text-muted-foreground">
          {total ? `${checked} of ${total} · ${percent}%` : 'Starting…'}
        </span>
      </p>
      <div
        role="progressbar"
        aria-label="Cost sources checked"
        aria-valuemin={0}
        aria-valuemax={total || 1}
        aria-valuenow={total ? checked : undefined}
        className="h-2 w-full rounded-full bg-muted overflow-hidden"
      >
        <div
          className="h-full bg-primary rounded-full transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p role="status" className="text-xs text-muted-foreground min-h-4">
        {current
          ? `Checking ${current.label}…`
          : total && checked === total
            ? 'Finishing refresh…'
            : 'Preparing usage sources…'}
      </p>
      {failed > 0 && (
        <p className="text-xs text-destructive">
          {failed} {failed === 1 ? 'source unavailable' : 'sources unavailable'}; previous values
          are kept where available.
        </p>
      )}
      {progress && (
        <details>
          <summary className="min-h-11 content-center text-muted-foreground hover:text-foreground">
            Details
          </summary>
          <p className="text-xs text-muted-foreground pb-2">
            Your previous report remains visible during refresh.
          </p>
          <ul className="space-y-2 border-t pt-2">
            {progress.sources.map((s) => (
              <li key={s.key} className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                <span className="min-w-0 break-words">{s.label}</span>
                <span
                  className={s.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}
                >
                  {s.status === 'failed'
                    ? 'Unavailable'
                    : s.status === 'waiting'
                      ? 'Queued'
                      : s.status === 'running'
                        ? 'Checking…'
                        : 'Complete'}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

export function StaleCostNotice({
  sources,
}: {
  sources: { label: string; lastSuccessAt?: string }[]
}) {
  if (!sources.length) return null
  return (
    <div role="status" className="rounded-xl border border-warning p-3 text-sm">
      <p>Some totals include older measurements.</p>
      <details className="mt-2">
        <summary className="cursor-pointer">View affected sources ({sources.length})</summary>
        <ul className="mt-2 space-y-1">
          {sources.map((s, i) => (
            <li key={i}>
              {s.label}
              {s.lastSuccessAt
                ? ` — last successful measurement ${new Date(s.lastSuccessAt).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' })}`
                : ' — reconciliation source unavailable'}
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}
