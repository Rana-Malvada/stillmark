import { useEffect, useRef, useState } from 'react'
import { Undo2, X } from 'lucide-react'
import { peopleApi } from '@/lib/people/people-client'
import type { Changed } from './types'

/** Status line after a change, with Undo for the most recent one. */
export function ChangeBar({
  changed,
  error,
  onDone,
  onDismiss,
}: {
  changed: Changed | null
  error: string
  onDone: () => Promise<void> | void
  onDismiss: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [undoError, setUndoError] = useState('')
  if (error)
    return (
      <div role="alert" className="people-change-notice text-sm text-destructive">
        <span>{error}</span>
        <button type="button" className="control" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    )
  if (!changed) return null
  const undoThis = async () => {
    setBusy(true)
    setUndoError('')
    try {
      // Undo exactly this change; the server refuses if a newer change exists.
      await peopleApi('/api/people/undo', 'POST', { id: changed.correctionId })
      onDismiss()
      await onDone()
    } catch (e) {
      // Undo can commit before its response is lost. Read, never repeat it.
      await Promise.resolve()
        .then(onDone)
        .catch(() => {})
      setUndoError(e instanceof Error ? e.message : 'Undo failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div role="status" className="people-change-notice text-sm">
      <span>{changed.message}</span>
      {changed.correctionId !== undefined && (
        <button
          type="button"
          onClick={undoThis}
          disabled={busy}
          className="inline-flex items-center gap-1 underline disabled:opacity-50"
        >
          <Undo2 className="w-3.5 h-3.5" aria-hidden="true" /> Undo
        </button>
      )}
      {undoError && <span className="text-destructive">{undoError}</span>}
      <button
        type="button"
        onClick={onDismiss}
        className="ml-auto p-1 rounded hover:bg-muted"
        aria-label="Dismiss"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

/** Runs a change and reports it; shared by every People screen. */
export function useChange(
  reload: () => Promise<void> | void,
  reconcile: () => Promise<void> | void = reload,
) {
  const [changed, setChanged] = useState<Changed | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const writing = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  async function run(
    message: string,
    action: () => Promise<unknown>,
    afterSave: () => Promise<void> | void = reload,
  ) {
    if (writing.current) return
    writing.current = true
    setBusy(true)
    setError('')
    setChanged(null)
    try {
      const result = (await action()) as { correctionId?: unknown } | undefined
      if (!mounted.current) return
      // Several requests (e.g. per-person review decisions) cannot be undone as one.
      const correctionId =
        typeof result?.correctionId === 'number' ? result.correctionId : undefined
      setChanged({ message, correctionId })
      await afterSave()
    } catch (e) {
      if (!mounted.current) return
      // Includes partial multi-person decisions: earlier requests may have committed.
      // A read restores the actual assignments without replaying a correction.
      await Promise.resolve()
        .then(reconcile)
        .catch(() => {})
      if (!mounted.current) return
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.')
    } finally {
      writing.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const bar = (
    <ChangeBar
      changed={changed}
      error={error}
      onDone={reload}
      onDismiss={() => {
        setChanged(null)
        setError('')
      }}
    />
  )
  return { run, busy, bar, setError }
}
