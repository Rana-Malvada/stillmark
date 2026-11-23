'use client'
import { useEffect, useRef, useState } from 'react'
import { useDialogViewport } from './use-dialog-viewport'
import { FaceImage, peopleApi, PersonPicker } from './people/shared'
import type { PhotoFace } from './people/photo-people-panel'

/** Explicit owner action on a dashed ignored-face box in the photo viewer. */
export function IgnoredFaceDialog({
  face,
  onClose,
  onSaved,
  onReconcile,
}: {
  face: PhotoFace
  onClose: () => void
  onSaved: () => Promise<void>
  onReconcile: () => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useDialogViewport(dialog)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  async function change(target?: { personId: string } | { name: string }) {
    setBusy(true)
    setError('')
    try {
      // Assignment already clears Ignore atomically and records correction history.
      await peopleApi(
        target ? '/api/people/assign' : '/api/people/ignore',
        'POST',
        target ? { faceIds: [face.faceId], ...target } : { faceIds: [face.faceId], ignored: false },
      )
      await onSaved()
    } catch (e) {
      await onReconcile().catch(() => {})
      setError(e instanceof Error ? e.message : 'Unable to update face')
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      onCancel={(e) => {
        if (busy) e.preventDefault()
        else onClose()
      }}
      aria-labelledby="ignored-face-title"
      className="app-dialog m-auto w-[min(32rem,calc(100%-2rem))] overflow-hidden rounded-xl border bg-card text-foreground p-0 backdrop:bg-scrim/60"
    >
      <div className="flex items-center justify-between gap-2 p-4 border-b">
        <h2 id="ignored-face-title" className="font-semibold">
          Ignored face
        </h2>
        <button className="control" disabled={busy} onClick={onClose}>
          Close
        </button>
      </div>
      <div className="overflow-y-auto min-h-0 p-4 space-y-4">
        <div className="flex items-center gap-3">
          <FaceImage faceId={face.faceId} hasCrop={face.hasCrop} className="w-16 h-16" />
          <p>{face.personName || 'Unnamed face'}</p>
        </div>
        <p className="text-sm text-muted-foreground">
          Undo Ignore keeps the previous assignment. Choosing a person restores this face and
          confirms that assignment.
        </p>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <button className="control" disabled={busy} onClick={() => void change()}>
          {busy ? 'Saving…' : 'Undo Ignore'}
        </button>
        <PersonPicker
          disabled={busy}
          label="Assign and restore"
          onPick={(target) => void change(target)}
        />
      </div>
    </dialog>
  )
}
