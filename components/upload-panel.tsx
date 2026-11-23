'use client'
import { watchUploadFolders } from '@/lib/upload/upload-folder-refresh'
import { createUploadFolderRequest } from '@/lib/upload/upload-folder-create'
import { useAuth } from './auth-provider'

import { UploadPoolReady } from './upload-pool-ready'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useClientValue } from './use-client-value'
import { useRouter } from 'next/navigation'
import { parseEventFolder } from '@/lib/albums/folder-parser'
import { AlertCircle, Check, FolderOpen, Loader2, Upload, X } from 'lucide-react'
import { isUploadMetadata, selectedMedia } from '@/lib/upload/upload-file-filter'
import { useUploads } from '@/components/upload-provider'

interface ParsedEvent {
  sortOrder: number | null
  eventName: string
  eventMonth: number | null
  eventYear: number | null
  sourceFolder: string
  location: string | null
  folderId: number | null
}

interface Folder {
  canSelect: boolean
  canEdit: boolean
  folderId: number
  folderName: string
}

interface UploadResult {
  filename: string
  status: string
  photoId?: number
  error?: string
  existingFilename?: string
}

function usesMobilePhotoPicker() {
  return (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

const MONTHS = [
  { value: 1, label: 'January' },
  { value: 2, label: 'February' },
  { value: 3, label: 'March' },
  { value: 4, label: 'April' },
  { value: 5, label: 'May' },
  { value: 6, label: 'June' },
  { value: 7, label: 'July' },
  { value: 8, label: 'August' },
  { value: 9, label: 'September' },
  { value: 10, label: 'October' },
  { value: 11, label: 'November' },
  { value: 12, label: 'December' },
]

export function UploadPanel() {
  const { role, username } = useAuth()
  const isAdmin = role === 'admin'
  const [files, setFiles] = useState<File[]>([])
  const [editedEvent, setEditedEvent] = useState<ParsedEvent | null>(null)
  const { queue, batches } = useUploads()
  const [batchId, setBatchId] = useState<string | null>(null)
  const batch = batches.find((b) => b.id === batchId)
  const uploading = batch?.running ?? false
  const fileProgress = batch?.files ?? []
  const progress = {
    current: fileProgress.filter((f) => ['success', 'skipped', 'failed'].includes(f.phase)).length,
    total: fileProgress.length,
  }
  const results: UploadResult[] | null =
    batch && !batch.running
      ? batch.files.map((f) => ({ filename: f.filename, status: f.phase, error: f.error }))
      : null
  const [error, setError] = useState<string | null>(null)
  const eventId = batch?.eventId
  const [folders, setFolders] = useState<Folder[]>([])
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [folderBusy, setFolderBusy] = useState(false)
  const folderPending = useRef(false)
  const [folderError, setFolderError] = useState<string | null>(null)
  const photosRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const [picking, setPicking] = useState(false)
  const mobilePicker = useClientValue(usesMobilePhotoPicker, false)

  useEffect(() => {
    const input = photosRef.current
    const cancel = () => setPicking(false)
    input?.addEventListener('cancel', cancel)
    return () => input?.removeEventListener('cancel', cancel)
  }, [])

  useEffect(() => {
    return watchUploadFolders((available) => {
      setFolders(available)
      setEditedEvent((current) =>
        current?.folderId && !available.some((f) => f.folderId === current.folderId)
          ? { ...current, folderId: null }
          : current,
      )
    })
  }, [])

  const handleFolderSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setPicking(false)
      const fileList = e.target.files
      if (!fileList || fileList.length === 0) {
        setError('No files were received from the picker. Please select the video again.')
        return
      }

      const selected = selectedMedia(Array.from(fileList))
      const imageFiles = selected.files
      setError(
        selected.rejected
          ? `${selected.rejected} unsupported file(s). Choose JPEG, HEIC, PNG, MOV, MP4 or M4V.`
          : null,
      )
      e.target.value = ''
      if (!imageFiles.length) return
      let folderName = ''

      for (let i = 0; i < imageFiles.length; i++) {
        const file = imageFiles[i]
        if (isUploadMetadata(file)) continue
        const path =
          (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
        if (!folderName && path.includes('/')) {
          folderName = path.split('/')[0]
        }
      }

      setFiles(imageFiles)
      setBatchId(null)

      if (!isAdmin) {
        const blank: ParsedEvent = {
          sortOrder: null,
          eventName: '',
          eventMonth: null,
          eventYear: null,
          sourceFolder: folderName || `phone-${crypto.randomUUID()}`,
          location: null,
          folderId: null,
        }
        setEditedEvent(blank)
      } else if (folderName) {
        const p = parseEventFolder(folderName)
        if (p) {
          setEditedEvent({ ...p, location: null, folderId: null })
        } else {
          // Folder name didn't match expected pattern -- let user fill in manually
          const fallback: ParsedEvent = {
            sortOrder: 0,
            eventName: folderName,
            eventMonth: null,
            eventYear: null,
            sourceFolder: folderName,
            location: null,
            folderId: null,
          }
          setEditedEvent(fallback)
        }
      } else if (imageFiles.length > 0) {
        // No folder name detected (flat file selection) -- let user fill in manually
        const fallback: ParsedEvent = {
          sortOrder: 0,
          eventName: 'Untitled Event',
          eventMonth: null,
          eventYear: null,
          sourceFolder: `phone-${crypto.randomUUID()}`,
          location: null,
          folderId: null,
        }
        setEditedEvent(fallback)
      }
    },
    [isAdmin],
  )

  const createUploadFolder = async () => {
    const name = folderName.trim().replace(/\s+/g, ' ')
    if (!name || !username || folderPending.current) return
    folderPending.current = true
    setFolderBusy(true)
    setFolderError(null)
    try {
      const data = await createUploadFolderRequest(name, username)
      setFolders((current) => [
        ...current.filter((folder) => folder.folderId !== data.folderId),
        { folderId: data.folderId, folderName: name, canSelect: true, canEdit: true },
      ])
      setEditedEvent((current) => (current ? { ...current, folderId: data.folderId } : current))
      setCreatingFolder(false)
      setFolderName('')
      window.dispatchEvent(new Event('gallery-folders-changed'))
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : 'Unable to create folder. Please try again.')
    } finally {
      folderPending.current = false
      setFolderBusy(false)
    }
  }

  const handleUpload = (retry = false) => {
    if (retry && batchId) {
      queue.retry(batchId)
      return
    }
    if (!editedEvent || !files.length || uploading || folderPending.current) return
    if (!editedEvent.eventName.trim()) {
      setError('Enter an event name before uploading.')
      return
    }
    if (!editedEvent.folderId) {
      setError('Choose a folder before uploading.')
      return
    }
    setBatchId(
      queue.start(
        files,
        { ...editedEvent, folderName: editedEvent.sourceFolder },
        editedEvent.eventName,
      ),
    )
  }

  const cancelSelection = () => {
    if (batchId) return
    setFiles([])
    setEditedEvent(null)
    setError(null)
    setPicking(false)
    if (photosRef.current) photosRef.current.value = ''
    router.push('/my-albums')
  }

  const totalSize = files.reduce((acc, f) => acc + f.size, 0)
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  const successCount = results?.filter((r) => r.status === 'success').length ?? 0
  const skippedCount = results?.filter((r) => r.status === 'skipped').length ?? 0
  const failedCount = results?.filter((r) => r.status === 'failed').length ?? 0

  return (
    <div className="w-full min-w-0 px-5 sm:px-8 py-5">
      <UploadPoolReady />
      <p className="eyebrow mb-1.5">Add to your collection</p>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h1 className="page-title">Upload an album.</h1>
        {!batchId && (
          <button
            type="button"
            onClick={cancelSelection}
            className="shrink-0 rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted"
          >
            Cancel
          </button>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Up to 64 MiB per photo and 4 GiB per video. Photo descriptions are generated automatically
        after upload.
      </p>

      {/* Folder selector */}
      <div className="mb-6">
        <label className="relative flex flex-col justify-center items-center gap-4 p-10 sm:p-14 w-full border border-dashed border-primary/50 bg-card rounded-2xl hover:border-primary hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground cursor-pointer">
          <input
            ref={photosRef}
            type="file"
            multiple
            disabled={uploading}
            accept={mobilePicker ? 'image/*,video/*' : undefined}
            {...(mobilePicker ? {} : { webkitdirectory: '' })}
            onClick={() => {
              setPicking(true)
              setError(null)
            }}
            onChange={handleFolderSelect}
            aria-label={
              mobilePicker ? 'Choose photos and videos' : 'Choose a folder to create an album'
            }
            className="absolute inset-0 h-full w-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
          />
          {mobilePicker ? (
            <Upload className="w-10 h-10 text-primary" />
          ) : (
            <FolderOpen className="w-10 h-10 text-primary" />
          )}
          <span>
            {files.length > 0
              ? `${files.length} files selected`
              : mobilePicker
                ? 'Choose photos and videos'
                : 'Choose a folder to create an album'}
          </span>
        </label>
      </div>

      {picking && (
        <p role="status" className="text-sm mb-4">
          Waiting for your phone to provide the selected files. Large or iCloud videos may need to
          download first. If the picker has closed without selecting files,{' '}
          <button
            className="underline"
            onClick={() => {
              setPicking(false)
              photosRef.current?.click()
            }}
          >
            choose again
          </button>
          .
        </p>
      )}
      {/* Parsed event preview */}
      {editedEvent && (
        <fieldset disabled={uploading || !!results} className="surface-panel p-6 mb-6 space-y-5">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Event Details
          </h2>
          <div className="grid grid-cols-2 gap-4">
            {isAdmin && (
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Sort Order</label>
                <input
                  type="number"
                  value={editedEvent.sortOrder ?? ''}
                  onChange={(e) =>
                    setEditedEvent({
                      ...editedEvent,
                      sortOrder:
                        e.target.value === '' ? (isAdmin ? 0 : null) : parseInt(e.target.value),
                    })
                  }
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
                />
              </div>
            )}
            <div className={!isAdmin ? 'col-span-2' : undefined}>
              <label className="block text-xs text-muted-foreground mb-1">Event Name</label>
              <input
                type="text"
                value={editedEvent.eventName}
                onChange={(e) => setEditedEvent({ ...editedEvent, eventName: e.target.value })}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Month</label>
              <select
                value={editedEvent.eventMonth ?? ''}
                onChange={(e) =>
                  setEditedEvent({
                    ...editedEvent,
                    eventMonth: e.target.value ? parseInt(e.target.value) : null,
                  })
                }
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
              >
                <option value="">--</option>
                {MONTHS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Year</label>
              <input
                type="number"
                value={editedEvent.eventYear ?? ''}
                onChange={(e) =>
                  setEditedEvent({
                    ...editedEvent,
                    eventYear: e.target.value ? parseInt(e.target.value) : null,
                  })
                }
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Location</label>
              <input
                type="text"
                value={editedEvent.location ?? ''}
                onChange={(e) =>
                  setEditedEvent({ ...editedEvent, location: e.target.value || null })
                }
                placeholder="e.g. Philadelphia, PA"
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
              />
            </div>
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                <label htmlFor="upload-folder" className="text-xs text-muted-foreground">
                  Folder (required)
                </label>
                <button
                  type="button"
                  className="text-xs text-primary underline"
                  onClick={() => {
                    setCreatingFolder(true)
                    setFolderError(null)
                  }}
                >
                  New folder
                </button>
              </div>
              <select
                id="upload-folder"
                onFocus={() => window.dispatchEvent(new Event('gallery-folders-changed'))}
                disabled={folderBusy}
                value={editedEvent.folderId ?? ''}
                onChange={(e) =>
                  setEditedEvent({
                    ...editedEvent,
                    folderId: e.target.value ? parseInt(e.target.value) : null,
                  })
                }
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
              >
                <option value="" disabled>
                  Choose a folder
                </option>
                {folders.map((f) => (
                  <option key={f.folderId} value={f.folderId}>
                    {f.folderName}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {creatingFolder && (
            <div className="space-y-2">
              <label htmlFor="new-upload-folder" className="block text-sm">
                New folder name
              </label>
              <input
                id="new-upload-folder"
                autoFocus
                maxLength={255}
                value={folderName}
                disabled={folderBusy}
                onChange={(e) => setFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void createUploadFolder()
                  }
                }}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={folderBusy || !folderName.trim()}
                  onClick={() => void createUploadFolder()}
                  className="px-3 py-2 rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
                >
                  {folderBusy ? 'Creating…' : 'Create folder'}
                </button>
                <button
                  type="button"
                  disabled={folderBusy}
                  onClick={() => {
                    setCreatingFolder(false)
                    setFolderError(null)
                  }}
                  className="px-3 py-2 rounded-lg border border-border"
                >
                  Cancel
                </button>
              </div>
              {folderError && (
                <p role="alert" className="text-sm text-destructive">
                  {folderError}
                </p>
              )}
            </div>
          )}
          {!editedEvent.folderId && (
            <p className="text-sm text-muted-foreground">
              {folders.length
                ? 'Choose a folder to enable upload.'
                : 'You have no folders yet. Choose New folder to create one here.'}
            </p>
          )}
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {files.length} images &middot; {formatSize(totalSize)}
            </span>
            <span className="text-xs">Folder: {editedEvent.sourceFolder}</span>
          </div>
        </fieldset>
      )}

      {/* Upload button */}
      {editedEvent && !results && (
        <div className="flex gap-3">
          <button
            onClick={() => handleUpload()}
            disabled={uploading || folderBusy || files.length === 0 || !editedEvent.folderId}
            className="flex items-center justify-center gap-2 w-full px-6 py-3 bg-primary text-primary-foreground rounded-xl font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {uploading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Uploading {progress.current} / {progress.total}...
              </>
            ) : (
              <>
                <Upload className="w-4 h-4" />
                Upload {files.length} photos
              </>
            )}
          </button>
          {!batchId && (
            <button
              type="button"
              onClick={cancelSelection}
              className="shrink-0 rounded-xl border border-border px-6 py-3 font-medium hover:bg-muted"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {!uploading && failedCount > 0 && (
        <button
          onClick={() => handleUpload(true)}
          className="mt-3 rounded-lg border px-4 py-2 text-sm"
        >
          Retry {failedCount} failed files
        </button>
      )}

      {/* Error */}
      {error && (
        <div className="mt-4 p-4 bg-destructive/10 text-destructive rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* Results */}
      {results && (
        <div className="mt-6 space-y-4">
          <div className="flex items-center gap-4 text-sm">
            {successCount > 0 && (
              <span className="flex items-center gap-1 text-success">
                <Check className="w-4 h-4" /> {successCount} uploaded
              </span>
            )}
            {skippedCount > 0 && (
              <span className="flex items-center gap-1 text-warning">
                <AlertCircle className="w-4 h-4" /> {skippedCount} skipped
              </span>
            )}
            {failedCount > 0 && (
              <span className="flex items-center gap-1 text-destructive">
                <X className="w-4 h-4" /> {failedCount} failed
              </span>
            )}
          </div>

          {eventId && (
            <div className="flex gap-3">
              <button
                onClick={() => router.push(`/events/${eventId}`)}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm hover:bg-primary/90"
              >
                View Event
              </button>
              <button
                onClick={() => {
                  setFiles([])
                  setEditedEvent(null)
                  setBatchId(null)
                }}
                className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted"
              >
                Upload Another
              </button>
            </div>
          )}

          {/* Failed files detail */}
          {failedCount > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Show {failedCount} failed files
              </summary>
              <div className="mt-2 space-y-1 max-h-60 overflow-y-auto">
                {results
                  .filter((r) => r.status === 'failed')
                  .map((r, i) => (
                    <div key={i} className="text-xs text-destructive">
                      {r.filename}: {r.error}
                    </div>
                  ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
