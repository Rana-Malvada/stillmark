'use client'
import { clientMutation } from '@/lib/client-operation'
import { isOk } from '@/lib/frontend-response-contracts'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth-provider'
import { Check, Pencil, Trash2, X } from 'lucide-react'

import { type FolderOption, loadFolderOptions } from '@/lib/albums/folder-options'
import { latestRequest } from '@/lib/latest-request'

interface Props {
  canEdit: boolean
  eventId: number
  eventName: string
  location: string | null
  sortOrder: number
  eventMonth: number | null
  eventYear: number | null
  folderId: number | null
}

export function EventActions({
  eventId,
  eventName,
  location,
  eventMonth,
  eventYear,
  folderId,
  sortOrder,
  canEdit,
}: Props) {
  const editDialog = useRef<HTMLDialogElement>(null)
  const deleteDialog = useRef<HTMLDialogElement>(null)
  const { role } = useAuth()
  const [editing, setEditing] = useState(false)
  const [month, setMonth] = useState(eventMonth?.toString() ?? '')
  const [year, setYear] = useState(eventYear?.toString() ?? '')
  const [order, setOrder] = useState(String(sortOrder))
  const [name, setName] = useState(eventName)
  const [loc, setLoc] = useState(location ?? '')
  const [selectedFolder, setSelectedFolder] = useState<number | null>(folderId)
  const [folders, setFolders] = useState<FolderOption[]>([])
  const [folderError, setFolderError] = useState('')
  const [loadingFolders, setLoadingFolders] = useState(false)
  const folderRequests = useRef(latestRequest())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  useEffect(() => {
    if (confirmDelete) deleteDialog.current?.showModal()
  }, [confirmDelete])
  const loadFolders = useCallback(async () => {
    const request = folderRequests.current.begin()
    setLoadingFolders(true)
    setFolderError('')
    try {
      const options = await loadFolderOptions(request.signal)
      if (request.current()) setFolders(options)
    } catch (e) {
      if (request.current())
        setFolderError(e instanceof Error ? e.message : 'Unable to load folders')
    } finally {
      if (request.current()) setLoadingFolders(false)
    }
  }, [])
  useEffect(() => {
    const requests = folderRequests.current
    if (editing) {
      editDialog.current?.showModal()
      // oxlint-disable-next-line react/set-state-in-effect -- the clear and load must run after the previous effect's cleanup cancels the last folder request; starting them in the click handler would have that cleanup cancel the new request
      setFolders([])
      void loadFolders()
    }
    return () => requests.cancel()
  }, [editing, loadFolders])

  if (!canEdit && role !== 'admin_readonly') return null

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await clientMutation(
        `/api/events/${eventId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventName: name,
            location: loc || null,
            eventMonth: month ? Number(month) : null,
            eventYear: year ? Number(year) : null,
            sortOrder: Number(order),
            ...(selectedFolder !== folderId ? { folderId: selectedFolder } : {}),
          }),
        },
        'Unable to save album',
        isOk,
        () => router.refresh(),
      )
      setEditing(false)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save album')
    } finally {
      setSaving(false)
    }
  }
  const handleDelete = async () => {
    setSaving(true)
    setError(null)
    try {
      await clientMutation(
        `/api/events/${eventId}`,
        { method: 'DELETE' },
        'Unable to delete album',
        isOk,
        () => router.refresh(),
      )
      router.push('/')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to delete album')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <dialog
        ref={editDialog}
        onClose={() => setEditing(false)}
        aria-label="Edit album details"
        className="album-settings-dialog"
      >
        <h2 className="text-lg font-semibold">Edit album details</h2>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="grid grid-cols-2 gap-4">
          <label className="col-span-2 text-xs space-y-1">
            Album name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="control block w-full"
              aria-label="Album name"
              placeholder="Album name"
              autoFocus
            />
          </label>
          <label className="col-span-2 text-xs space-y-1">
            Location
            <input
              value={loc}
              onChange={(e) => setLoc(e.target.value)}
              className="control block w-full"
              aria-label="Location"
              placeholder="Location"
            />
          </label>
          <label className="text-xs">
            Month
            <select
              aria-label="Month"
              className="control block w-full"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            >
              <option value="">Unknown</option>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {new Date(2000, i, 1).toLocaleString('en', { month: 'long' })}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            Year
            <input
              aria-label="Year"
              className="control block w-full"
              type="number"
              min="1"
              max="9999"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
          </label>
          <label className="text-xs">
            Sort order
            <input
              aria-label="Sort order"
              className="control block w-full"
              type="number"
              min="0"
              value={order}
              onChange={(e) => setOrder(e.target.value)}
            />
          </label>
          <label className="text-xs space-y-1">
            Folder
            <select
              aria-label="Folder"
              disabled={loadingFolders || !!folderError}
              value={selectedFolder ?? ''}
              onChange={(e) => setSelectedFolder(e.target.value ? Number(e.target.value) : null)}
              className="control block w-full"
            >
              <option value="">No folder</option>
              {selectedFolder !== null &&
                !folders.some((folder) => folder.folderId === selectedFolder) && (
                  <option value={selectedFolder}>Current folder</option>
                )}
              {folders.map((f) => (
                <option key={f.folderId} value={f.folderId}>
                  {f.folderName}
                </option>
              ))}
            </select>
          </label>
        </div>
        {loadingFolders && (
          <p role="status" className="text-sm">
            Loading folders…
          </p>
        )}
        {folderError && (
          <p role="alert" className="text-sm text-destructive">
            {folderError}{' '}
            <button type="button" className="control" onClick={() => void loadFolders()}>
              Retry folders
            </button>
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={handleSave}
            disabled={saving || !canEdit}
            className="control control-primary"
          >
            <Check className="w-4 h-4 inline" /> Save details
          </button>
          <button
            disabled={!canEdit}
            onClick={() => {
              setEditing(false)
              setName(eventName)
              setLoc(location ?? '')
              setSelectedFolder(folderId)
              setMonth(eventMonth?.toString() ?? '')
              setYear(eventYear?.toString() ?? '')
              setOrder(String(sortOrder))
            }}
            className="control"
          >
            <X className="w-4 h-4 inline" /> Cancel
          </button>
        </div>
      </dialog>
    )
  }

  return (
    <div className="w-full">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <button
        disabled={!canEdit}
        onClick={() => setEditing(true)}
        className="album-menu-item"
        title="Edit album details"
      >
        <Pencil className="w-3.5 h-3.5 inline mr-1" />
        Edit details
      </button>
      <button
        disabled={!canEdit}
        onClick={() => setConfirmDelete(true)}
        className="album-menu-item text-destructive"
        title="Delete album"
      >
        <Trash2 className="w-4 h-4" /> Delete album
      </button>

      {confirmDelete && (
        <dialog
          ref={deleteDialog}
          onClose={() => setConfirmDelete(false)}
          aria-label="Delete album"
          className="album-settings-dialog"
        >
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Delete this album?</h3>
            <p className="text-sm text-muted-foreground">
              The album will be removed. Its photos and videos can be restored from Trash into
              another album for 30 days.
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex gap-3 justify-end">
              <button
                disabled={!canEdit}
                onClick={() => setConfirmDelete(false)}
                className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={saving || !canEdit}
                className="px-4 py-2 text-sm rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </button>
            </div>
          </div>
        </dialog>
      )}
    </div>
  )
}
