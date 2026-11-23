import type { ReactNode } from 'react'

export function MobileActivityCards({
  entries,
}: {
  entries: {
    id: string
    title: string
    subtitle: string
    fields: { label: string; value: ReactNode }[]
  }[]
}) {
  return (
    <div className="space-y-3 sm:hidden">
      {entries.map((entry) => (
        <article key={entry.id} className="rounded-xl border bg-card p-3">
          <h3 className="font-medium break-words">{entry.title}</h3>
          <p className="text-xs text-muted-foreground break-words">{entry.subtitle}</p>
          <details>
            <summary className="min-h-11 flex items-center cursor-pointer text-sm underline">
              View details
            </summary>
            <dl className="space-y-2 text-sm">
              {entry.fields.map((field) => (
                <div key={field.label}>
                  <dt className="text-muted-foreground">{field.label}</dt>
                  <dd className="break-words">{field.value || '—'}</dd>
                </div>
              ))}
            </dl>
          </details>
        </article>
      ))}
    </div>
  )
}
