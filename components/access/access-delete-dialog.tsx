import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useDialogViewport } from '../use-dialog-viewport'
import { useChanged } from '../use-changed'
import {
  accountLabel,
  matchesAccountDeletionConfirmation,
} from '@/lib/identity/account-presentation'
import type { User } from '@/lib/identity/access-response'
import type { AccessController } from './use-access-controller'

interface Props {
  deleteTarget: User | null
  setDeleteTarget: (user: User | null) => void
  busy: boolean
  error: string
  execute: AccessController['execute']
}
/** Always mounted; only the target changes, preserving the native dialog lifecycle. */
export function AccessDeleteDialog({ deleteTarget, setDeleteTarget, busy, error, execute }: Props) {
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [deleteConfirmationError, setDeleteConfirmationError] = useState('')
  const deleteDialog = useRef<HTMLDialogElement>(null)
  useDialogViewport(deleteDialog)
  if (useChanged(deleteTarget)) {
    setDeleteConfirmation('')
    setDeleteConfirmationError('')
  }
  useEffect(() => {
    if (deleteTarget) deleteDialog.current?.showModal()
    else deleteDialog.current?.close()
  }, [deleteTarget])
  function confirmDelete(event: FormEvent) {
    event.preventDefault()
    if (!deleteTarget || busy) return
    if (!matchesAccountDeletionConfirmation(deleteConfirmation, deleteTarget.email)) {
      setDeleteConfirmationError(
        deleteTarget.email
          ? 'The email does not match. Enter the email shown above to delete this user.'
          : 'Type DELETE to confirm deletion.',
      )
      return
    }
    setDeleteConfirmationError('')
    void execute({
      action: 'deleteUser',
      name: deleteTarget.name,
      marker: deleteTarget.marker,
      confirmation: deleteTarget.name,
    })
  }
  return (
    <dialog
      ref={deleteDialog}
      aria-labelledby="delete-account-title"
      onCancel={(e) => {
        if (busy) e.preventDefault()
        else setDeleteTarget(null)
      }}
      className="app-dialog m-auto w-[min(32rem,calc(100%-2rem))] rounded-xl border bg-card text-foreground p-5 backdrop:bg-scrim/60"
    >
      <form onSubmit={confirmDelete}>
        <h2 id="delete-account-title" className="text-xl font-semibold">
          Delete user?
        </h2>
        <p className="my-3 break-words">{deleteTarget ? accountLabel(deleteTarget) : ''}</p>
        <p className="text-sm text-muted-foreground">
          This removes their login and app access. Albums and photos stay under their original owner
          in the admin-only Deleted accounts area. Shared links and album sharing are revoked.
        </p>
        <label htmlFor="delete-account-confirmation" className="block mt-4 text-sm">
          Type <strong className="break-words">{deleteTarget?.email?.trim() || 'DELETE'}</strong> to
          confirm.
        </label>
        <input
          id="delete-account-confirmation"
          className="control w-full mt-2"
          type="text"
          inputMode={deleteTarget?.email ? 'email' : 'text'}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={busy}
          value={deleteConfirmation}
          aria-invalid={!!deleteConfirmationError}
          aria-describedby={
            deleteConfirmationError ? 'delete-account-confirmation-error' : undefined
          }
          onChange={(event) => {
            setDeleteConfirmation(event.target.value)
            setDeleteConfirmationError('')
          }}
        />
        {deleteConfirmationError && (
          <p
            id="delete-account-confirmation-error"
            role="alert"
            className="mt-2 text-sm text-destructive"
          >
            {deleteConfirmationError}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-destructive">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="control"
            disabled={busy}
            onClick={() => setDeleteTarget(null)}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="control text-destructive"
            disabled={busy || !deleteTarget}
          >
            {busy ? 'Deleting…' : 'Delete user'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
