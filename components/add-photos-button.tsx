'use client'
import { selectedMedia } from '@/lib/upload/upload-file-filter'
import { isBatchUploading } from '@/lib/upload/upload-queue'
import { useUploads } from '@/components/upload-provider'

import { useRef, useState } from 'react'
import { useAuth } from '@/components/auth-provider'
import { Check, Loader2, Plus, X } from 'lucide-react'

export function AddPhotosButton({
  eventId,
  sourceFolder,
  canEdit,
  folderId,
}: {
  folderId: number | null
  eventId: number
  sourceFolder: string
  canEdit: boolean
}) {
  const { role } = useAuth()
  const { queue, batches } = useUploads()
  const [selectionError, setSelectionError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const batch = [...batches].reverse().find((b) => b.eventId === eventId)
  const uploading = batch ? isBatchUploading(batch) : false
  const fileProgress = batch?.files ?? []
  const summary =
    batch && !batch.running
      ? {
          success: fileProgress.filter((f) => f.phase === 'success').length,
          skipped: fileProgress.filter((f) => f.phase === 'skipped').length,
          failed: fileProgress.filter((f) => f.phase === 'failed').length,
        }
      : null

  if (!canEdit && role !== 'admin_readonly') return null

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (!fileList || fileList.length === 0) return

    const { files, rejected } = selectedMedia(Array.from(fileList))
    setSelectionError(
      rejected ? `${rejected} unsupported file(s). Choose JPEG, HEIC, PNG, MOV, MP4 or M4V.` : '',
    )
    e.target.value = ''
    if (!files.length) return
    if (folderId === null) {
      setSelectionError('Assign this album to a folder in Edit details before uploading.')
      return
    }

    queue.start(files, { folderName: sourceFolder, eventId }, sourceFolder)
    e.target.value = ''
  }

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          /* @ts-expect-error webkitdirectory is non-standard */
          webkitdirectory="true"
          multiple
          onChange={handleFiles}
          className="hidden"
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*"
          onChange={handleFiles}
          className="hidden"
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || !canEdit || folderId === null}
          className="control inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          {uploading ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Uploading...
            </>
          ) : (
            <>
              <Plus className="w-3.5 h-3.5" /> Add Files
            </>
          )}
        </button>
        <button
          onClick={() => inputRef.current?.click()}
          disabled={uploading || !canEdit || folderId === null}
          className="control inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          <Plus className="w-3.5 h-3.5" /> Add Folder
        </button>
        {summary && (
          <span className="text-xs text-muted-foreground flex items-center gap-2">
            {summary.success > 0 && (
              <span className="flex items-center gap-0.5 text-success">
                <Check className="w-3 h-3" />
                {summary.success} added
              </span>
            )}
            {summary.skipped > 0 && <span>{summary.skipped} skipped</span>}
            {summary.failed > 0 && (
              <span className="flex items-center gap-0.5 text-destructive">
                <X className="w-3 h-3" />
                {summary.failed} failed
              </span>
            )}
          </span>
        )}
      </div>
      {folderId === null && (
        <p className="text-sm text-muted-foreground">
          Choose a folder under More → Edit details before adding files.
        </p>
      )}
      {selectionError && (
        <p role="alert" className="text-sm text-destructive">
          {selectionError}
        </p>
      )}
      {!uploading && !!summary?.failed && (
        <button
          disabled={!canEdit}
          onClick={() => batch && queue.retry(batch.id)}
          className="rounded-lg border px-3 py-2 text-sm"
        >
          Retry {summary.failed} failed files
        </button>
      )}
    </div>
  )
}
