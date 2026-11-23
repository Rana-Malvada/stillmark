import type { ReactNode } from 'react'

/** Shared presentation only: each job keeps its own controls and authoritative counts. */
export function BatchProgress({
  status,
  done,
  total,
  unit,
  metrics,
  updated,
  elapsed,
  children,
}: {
  status: string
  done: number
  total: number
  unit: string
  metrics: { label: string; value: number }[]
  updated?: string | number | null
  elapsed?: number
  children?: ReactNode
}) {
  const percent = total > 0 ? Math.min(100, Math.max(0, Math.floor((done / total) * 100))) : 0
  return (
    <div className="rounded-xl bg-muted/40 p-4 sm:p-6 space-y-5 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="font-semibold">
          {status}
        </p>
        {updated && (
          <span className="text-xs text-muted-foreground">
            Checked {new Date(updated).toLocaleTimeString()}
          </span>
        )}
      </div>
      {children}
      <div>
        <div className="flex items-baseline justify-between gap-3 tabular-nums">
          <p className="text-2xl sm:text-3xl font-semibold">
            {done.toLocaleString()}{' '}
            <span className="text-lg text-muted-foreground">/ {total.toLocaleString()}</span>
          </p>
          <span className="text-xl font-semibold">{percent}%</span>
        </div>
        <p className="text-sm text-muted-foreground mt-1">{unit}</p>
        <div
          role="progressbar"
          aria-label={unit}
          aria-valuemin={0}
          aria-valuemax={Math.max(1, total)}
          aria-valuenow={Math.min(Math.max(0, done), Math.max(1, total))}
          className="h-2 rounded-full bg-muted overflow-hidden mt-4"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-3 tabular-nums">
        {metrics.map((m) => (
          <div key={m.label} className="min-w-0">
            <dd className="text-xl sm:text-2xl font-semibold">{m.value.toLocaleString()}</dd>
            <dt className="text-xs sm:text-sm text-muted-foreground mt-1">{m.label}</dt>
          </div>
        ))}
      </dl>
      {elapsed !== undefined && (
        <p className="border-t border-border pt-3 text-sm text-muted-foreground tabular-nums">
          Elapsed {Math.floor(elapsed / 60)}m {Math.floor(elapsed % 60)}s
        </p>
      )}
    </div>
  )
}

export function BatchHelp({ children }: { children: ReactNode }) {
  return (
    <details className="text-sm text-muted-foreground">
      <summary className="cursor-pointer w-fit" aria-label="About this process">
        ⓘ How it works
      </summary>
      <div className="pt-2 max-w-prose">{children}</div>
    </details>
  )
}
