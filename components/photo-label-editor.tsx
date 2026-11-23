'use client'
import { clientMutation, clientOperation } from '@/lib/client-operation'
import { isLabels } from '@/lib/frontend-response-contracts'
import { isPhotoDetail } from './gallery/photo-detail-data'
import { SearchUpdateHint } from './processing-settings'
import { Pencil } from 'lucide-react'
import { useRef, useState } from 'react'

export function PhotoLabelEditor({
  photoId,
  caption,
  aiDescription,
  tags,
  onSaved,
  canEdit,
}: {
  canEdit: boolean
  photoId: number
  caption: string | null
  aiDescription: string | null
  tags: string[]
  onSaved: (labels: { caption: string | null; tags: string[] }) => void
}) {
  const readOnly = !canEdit
  const dialog = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState('')
  const [tagText, setTagText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  function open() {
    setText(caption ?? aiDescription ?? '')
    setTagText(tags.join(', '))
    setError('')
    dialog.current?.showModal()
  }
  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const data = await clientMutation(
        `/api/photos/${photoId}/labels`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            caption: text,
            tags: tagText
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean),
          }),
        },
        'Unable to save caption and tags',
        isLabels,
        async () => {
          const current = await clientOperation(
            `/api/photos/${photoId}`,
            { cache: 'no-store' },
            'Could not check saved labels',
            isPhotoDetail,
          )
          setText(current.caption ?? '')
          setTagText(current.userTags.join(', '))
          onSaved({ caption: current.caption, tags: current.userTags })
        },
      )
      onSaved(data)
      dialog.current?.close()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        onClick={open}
        className="rounded border border-border px-2 py-1 text-xs text-foreground"
      >
        <Pencil aria-hidden="true" />
        Edit caption & tags
      </button>
      <dialog
        ref={dialog}
        onCancel={(e) => {
          if (busy) e.preventDefault()
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-lg max-h-[90dvh] overflow-y-auto rounded-xl border border-border bg-card text-card-foreground p-5 backdrop:bg-scrim/75"
      >
        <form onSubmit={save} className="space-y-4">
          <h2 className="text-lg font-semibold">Caption & tags</h2>
          <p className="text-sm text-muted-foreground">
            Edit your description below. The original AI description is preserved.
          </p>
          <label className="block text-sm">
            Caption / description
            <textarea
              autoFocus
              value={text}
              maxLength={5000}
              rows={6}
              disabled={busy || readOnly}
              onChange={(e) => setText(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-border bg-background p-3"
            />
          </label>
          <label className="block text-sm">
            Your tags
            <input
              value={tagText}
              disabled={busy || readOnly}
              onChange={(e) => setTagText(e.target.value)}
              placeholder="family, beach, summer holiday"
              className="mt-1 block w-full rounded-lg border border-border bg-background p-3"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Separate tags with commas. Up to 20 tags, 64 characters each. <SearchUpdateHint />
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => dialog.current?.close()}
              className="rounded-lg border px-3 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              disabled={busy || readOnly}
              className="rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}
