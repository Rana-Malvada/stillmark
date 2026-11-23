'use client'
import { clientMutation } from '@/lib/client-operation'
import { isOk } from '@/lib/frontend-response-contracts'
import { CalendarDays } from 'lucide-react'
import { useState } from 'react'
import { useChanged } from './use-changed'

export function CaptureDateEditor({
  photoId,
  date,
  onSaved,
  canEdit,
}: {
  canEdit: boolean
  photoId: number
  date: string | null
  onSaved: () => void
}) {
  const readOnly = !canEdit
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(date?.slice(0, 19) ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (useChanged(date)) setValue(date?.slice(0, 19) ?? '')
  async function save(clear = false) {
    if (!clear && !value) {
      setError('Enter a date and time')
      return
    }
    setBusy(true)
    setError('')
    try {
      await clientMutation(
        `/api/photos/${photoId}/date`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dateTaken: clear ? null : new Date(value + 'Z').toISOString() }),
        },
        'Unable to save date',
        isOk,
        onSaved,
      )
      setOpen(false)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save date')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="text-foreground text-xs">
      <button className="rounded border border-border px-2 py-1" onClick={() => setOpen(!open)}>
        <CalendarDays aria-hidden="true" />
        Edit capture date
      </button>
      {open && (
        <div className="absolute right-4 top-16 z-30 rounded-xl border border-border bg-popover p-4 space-y-3 shadow-xl">
          <label className="block">
            Capture date and time (UTC)
            <input
              disabled={readOnly || busy}
              type="datetime-local"
              step="1"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="block bg-muted p-2 rounded mt-1"
            />
          </label>
          <p>Changes album ordering. Original file metadata is preserved.</p>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-3">
            <button disabled={busy || readOnly} onClick={() => save()}>
              Save
            </button>
            <button disabled={busy || readOnly} onClick={() => save(true)}>
              Clear date
            </button>
            <button onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
