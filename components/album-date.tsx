'use client'
import { clientMutation } from '@/lib/client-operation'
import { isCount } from '@/lib/frontend-response-contracts'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarDays } from 'lucide-react'

export function AlbumDate({ eventId, canEdit }: { eventId: number; canEdit: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const router = useRouter()
  const [date, setDate] = useState('')
  const [scope, setScope] = useState('all')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  if (!canEdit) return null
  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await clientMutation(
        `/api/events/${eventId}/date`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date, scope }),
        },
        'Unable to update photo dates',
        isCount,
        () => {
          window.dispatchEvent(new CustomEvent('gallery-photos-updated', { detail: eventId }))
          router.refresh()
        },
      )
      setMessage(`Date updated for ${result.count} photo${result.count === 1 ? '' : 's'}.`)
      window.dispatchEvent(new CustomEvent('gallery-photos-updated', { detail: eventId }))
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update photo dates')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="shrink-0">
      <button
        className="album-menu-item"
        onClick={() => {
          setError('')
          setMessage('')
          dialog.current?.showModal()
        }}
      >
        <CalendarDays className="h-4 w-4" /> Set photo dates
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="album-date-title"
        onCancel={(e) => {
          if (busy) e.preventDefault()
        }}
        className="m-auto w-[min(480px,calc(100%-2rem))] rounded-2xl border border-border bg-card text-card-foreground p-6 backdrop:bg-scrim/70"
      >
        <form onSubmit={save} className="space-y-4">
          <h2 id="album-date-title" className="text-xl font-semibold">
            Set photo dates
          </h2>
          <label className="block text-sm">
            Capture date (UTC)
            <input
              type="date"
              required
              value={date}
              disabled={busy}
              onChange={(e) => setDate(e.target.value)}
              className="control block w-full min-h-12 mt-2 text-base"
            />
          </label>
          <label className="block text-sm">
            Apply to
            <select
              value={scope}
              disabled={busy}
              onChange={(e) => setScope(e.target.value)}
              className="control block w-full min-h-12 mt-2 text-base"
            >
              <option value="all">All photos in this album</option>
              <option value="missing">Only photos missing a date</option>
            </select>
          </label>
          <p className="text-sm text-muted-foreground">
            {scope === 'all' ? 'Replaces existing photo dates.' : 'Fills in missing photo dates.'}{' '}
            Existing capture times are kept in UTC; photos without a date use midnight. Changes
            photo ordering. Videos and original files stay unchanged.
          </p>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {message && <p role="status">{message}</p>}
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={busy || !date}
              className="control min-h-12 disabled:opacity-50"
            >
              {busy ? 'Applying…' : 'Apply date'}
            </button>
            <button
              type="button"
              disabled={busy}
              className="control min-h-12"
              onClick={() => dialog.current?.close()}
            >
              Close
            </button>
          </div>
        </form>
      </dialog>
    </div>
  )
}
