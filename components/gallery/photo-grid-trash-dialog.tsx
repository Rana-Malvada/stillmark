import type { PhotoGridController } from './use-photo-grid-controller'

export function PhotoGridTrashDialog({
  grid,
}: {
  grid: Pick<PhotoGridController, 'selection' | 'actions'>
}) {
  const { selected, editable } = grid.selection
  const { busy, actionError, setConfirmTrash, trashDialog, trashHeading, act } = grid.actions
  const control = 'control disabled:opacity-50'
  return (
    <dialog
      ref={trashDialog}
      aria-labelledby={trashHeading}
      className="app-dialog m-auto w-[min(28rem,calc(100%-2rem))] max-h-[85dvh] overflow-y-auto rounded-xl border border-border bg-card text-foreground p-4 backdrop:bg-scrim/70"
      onCancel={(e) => {
        if (busy) e.preventDefault()
        else setConfirmTrash(false)
      }}
      onClose={() => setConfirmTrash(false)}
    >
      <h2 id={trashHeading} className="text-lg font-semibold">
        Move to Trash?
      </h2>
      <p className="my-3 text-sm">
        Move {selected.length} selected files to Trash? You can restore them for 30 days.
      </p>
      {actionError && (
        <p role="alert" className="mb-3 text-destructive">
          {actionError}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          autoFocus
          disabled={busy}
          className={control}
          onClick={() => setConfirmTrash(false)}
        >
          Cancel
        </button>
        <button disabled={busy || !editable} className={control} onClick={() => act('trash')}>
          {busy ? 'Moving to Trash…' : 'Move to Trash'}
        </button>
      </div>
    </dialog>
  )
}
