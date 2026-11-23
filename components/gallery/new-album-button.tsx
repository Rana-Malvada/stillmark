'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth-provider'
import { readClientResponse } from '@/lib/client-response'
import type { FolderData } from './event-grid-data'

export function NewAlbumButton({ folders }: { folders: FolderData[] }) {
  const router = useRouter()
  const { loading, canManagePersonal } = useAuth()
  const [folderId, setFolderId] = useState('')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function create(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !name.trim()) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventName: name, folderId: folderId ? Number(folderId) : null }),
      })
      const data = await readClientResponse<{ eventId: number }>(
        response,
        'Unable to create album',
        (value): value is { eventId: number } =>
          typeof value === 'object' &&
          value !== null &&
          'eventId' in value &&
          Number.isSafeInteger(value.eventId) &&
          Number(value.eventId) > 0,
      )
      setOpen(false)
      setName('')
      router.push(`/events/${data.eventId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to create album')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <button
        disabled={loading || !canManagePersonal}
        className="primary-button"
        onClick={() => setOpen(!open)}
      >
        New private album
      </button>
      {open && (
        <form className="mt-3 flex flex-wrap gap-2 items-center" onSubmit={create}>
          <input
            autoFocus
            aria-label="New album name"
            placeholder="Album name"
            className="control"
            maxLength={255}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
          <select
            aria-label="Album folder"
            className="control"
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            disabled={busy}
          >
            <option value="">Uncategorized</option>
            {folders
              .filter((f) => f.canSelect)
              .map((f) => (
                <option key={f.folderId} value={f.folderId}>
                  {f.folderName}
                </option>
              ))}
          </select>
          <button className="primary-button" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
          <button type="button" className="control" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </button>
          <p className="w-full text-xs text-muted-foreground">
            Only you and the main admin can access it until you share it.
          </p>
          {error && (
            <p role="alert" className="w-full text-destructive">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  )
}
