import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { latestRequest } from '@/lib/latest-request'
import { type HistoryItem, loadPeopleHistory } from './history-loader'
import { peopleApi, peopleControl, useChange } from './shared'

export function HistorySection({
  readOnly,
  onChange,
}: {
  readOnly: boolean
  onChange: () => Promise<void>
}) {
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const loadingRequest = useRef(latestRequest())
  const fetchHistory = useCallback(async () => {
    const request = loadingRequest.current.begin()
    try {
      const history = await loadPeopleHistory(request.signal)
      if (request.current()) setItems(history)
    } catch (error) {
      if (request.current())
        setLoadError(error instanceof Error ? error.message : 'Could not load history. Try again.')
    }
  }, [])
  const load = useCallback(async () => {
    setItems(null)
    setLoadError('')
    await fetchHistory()
  }, [fetchHistory])
  const { run, busy, bar } = useChange(async () => {
    await load()
    await onChange()
  })
  useEffect(() => {
    const owner = loadingRequest.current
    // Mount already shows the loading state; only Retry and Undo need load()'s reset.
    void fetchHistory()
    return () => owner.cancel()
  }, [fetchHistory])
  return (
    <section aria-label="History" className="w-full min-w-0">
      <p className="text-sm text-muted-foreground mb-4">
        Your last 50 changes. Undo goes back one change at a time, newest first.
      </p>
      {bar}
      {loadError ? (
        <div role="alert" className="space-y-3 text-sm">
          <p>{loadError}</p>
          <button type="button" className={peopleControl} onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : !items ? (
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" aria-label="Loading" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No changes yet.</p>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-lg">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className={item.undoneAt ? 'line-through text-muted-foreground' : ''}>
                {item.summary}
              </span>
              <time className="text-xs text-muted-foreground" dateTime={item.createdAt}>
                {new Date(item.createdAt).toLocaleString()}
              </time>
              {item.canUndo && !readOnly && (
                <button
                  type="button"
                  disabled={busy}
                  className="ml-auto underline disabled:opacity-50"
                  onClick={() =>
                    run(`Undid: ${item.summary}`, () =>
                      peopleApi('/api/people/undo', 'POST', { id: item.id }),
                    )
                  }
                >
                  Undo
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
