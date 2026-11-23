'use client'
import { clientMutation, clientOperation } from '@/lib/client-operation'
import { isCount, isTrashPage } from '@/lib/frontend-response-contracts'
import { Thumbnail } from './thumbnail'
import { useAlbumDestinations } from './gallery/use-album-destinations'
import { latestRequest } from '@/lib/latest-request'
import { useAuth } from './auth-provider'
import { useCallback, useEffect, useRef, useState } from 'react'

interface Item {
  photoId: number
  filename: string
  albumName: string
  expiresAt: string
}
function TrashThumbnail({ id }: { id: number }) {
  return (
    <Thumbnail
      src={`/api/trash/${id}/thumbnail`}
      alt=""
      className="w-16 h-16 shrink-0 object-cover rounded"
    />
  )
}

export function TrashPanel() {
  const { canManagePersonal, username } = useAuth()
  const readOnly = !canManagePersonal

  const [files, setFiles] = useState<Item[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const {
    albums,
    destination,
    setDestination,
    cursor: albumCursor,
    loading: loadingAlbums,
    error: albumError,
    load: loadAlbums,
    retryCursor: failedAlbumCursor,
  } = useAlbumDestinations({ scope: `${username}:${readOnly}`, order: 'server', autoLoad: true })
  const [page, setPage] = useState(1)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const requests = useRef(latestRequest())
  const load = useCallback(async () => {
    const request = requests.current.begin()
    setLoading(true)
    try {
      const data = await clientOperation(
        `/api/trash?page=${page}`,
        { signal: request.signal },
        'Unable to load Trash',
        isTrashPage,
      )
      if (!request.current()) return
      setFiles(data.files)
      setMore(data.hasMore)
      setSelected([])
      setError('')
    } catch (e) {
      if (request.current()) setError(e instanceof Error ? e.message : 'Unable to load Trash')
    } finally {
      if (request.current()) setLoading(false)
    }
  }, [page])
  useEffect(() => {
    const owner = requests.current
    // oxlint-disable-next-line react/set-state-in-effect -- load raises the loading flag as it supersedes the previous page's request; raising it earlier would let that request's completion clear it
    void load()
    return () => owner.cancel()
  }, [load])
  const restore = async () => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const data = await clientMutation(
        '/api/trash',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ids: selected,
            eventId: destination ? Number(destination) : undefined,
          }),
        },
        'Restore failed',
        isCount,
        load,
      )
      setMessage(`${data.count} files restored`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (all: boolean) => {
    if (
      !window.confirm(
        all
          ? 'Permanently delete EVERY file in Trash? This cannot be undone.'
          : `Permanently delete ${selected.length} selected files? This cannot be undone.`,
      )
    )
      return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const data = await clientMutation(
        '/api/trash',
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ all, ids: selected, confirm: 'PERMANENTLY_DELETE' }),
        },
        'Deletion failed',
        isCount,
        load,
      )
      setMessage(
        `${data.count} files permanently deleted from Trash. Storage removal is queued; see Activity for progress.`,
      )
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deletion failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="report-page w-full min-w-0 px-5 sm:px-8 py-5 space-y-5">
      <div>
        <p className="eyebrow mb-1.5">Manage your collection</p>
        <h1 className="page-title">Trash</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Restore deleted files for 30 days. After that, they are permanently removed. If an album was
        deleted, choose another album below.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}{' '}
          <button className="control" disabled={loading} onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="flex flex-wrap gap-3 items-center">
        <button
          disabled={loading || busy || !files.length}
          onClick={() =>
            setSelected(selected.length === files.length ? [] : files.map((f) => f.photoId))
          }
          className="border rounded px-3 py-2"
        >
          {selected.length === files.length && files.length ? 'Deselect all' : 'Select page'}
        </button>
        <select
          aria-label="Restore destination"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          disabled={loading || busy}
          className="border rounded px-3 py-2 bg-background"
        >
          <option value="">Original albums</option>
          {albums.map((a) => (
            <option key={a.eventId} value={a.eventId}>
              {a.eventName}
            </option>
          ))}
        </select>
        {(albumCursor || loadingAlbums) && (
          <button
            className="border rounded px-3 py-2"
            disabled={loadingAlbums || busy}
            onClick={() => void loadAlbums(albumCursor)}
          >
            {loadingAlbums ? 'Loading albums…' : 'Load more albums'}
          </button>
        )}
        <button
          disabled={loading || busy || readOnly || !selected.length}
          onClick={restore}
          className="border rounded px-3 py-2 disabled:opacity-50"
        >
          {busy ? 'Working…' : `Restore ${selected.length} selected`}
        </button>
      </div>
      {albumError && (
        <p role="alert" className="text-destructive">
          {albumError}{' '}
          <button
            className="control"
            disabled={loadingAlbums || busy}
            onClick={() => void loadAlbums(failedAlbumCursor.current)}
          >
            Retry albums
          </button>
        </p>
      )}
      <details className="rounded-xl border border-destructive/40 p-3">
        <summary className="min-h-11 flex items-center cursor-pointer text-destructive font-medium">
          Permanent deletion
        </summary>
        <p className="text-sm text-muted-foreground mb-3">
          These actions cannot be undone. Use Restore above to keep files.
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            disabled={loading || busy || readOnly || !selected.length}
            onClick={() => remove(false)}
            className="rounded border px-3 py-2 text-destructive disabled:opacity-50"
          >
            Permanently delete selected
          </button>
          <button
            disabled={loading || busy || readOnly}
            onClick={() => remove(true)}
            className="rounded border px-3 py-2 text-destructive"
          >
            Empty Trash
          </button>
        </div>
      </details>
      {loading && <p role="status">Loading Trash…</p>}
      {!loading && !files.length && !error && <p>No files in Trash on this page.</p>}
      <ul className="divide-y">
        {files.map((f) => (
          <li key={f.photoId} className="py-3">
            <label className="flex gap-3 items-center">
              <input
                type="checkbox"
                disabled={loading || busy}
                checked={selected.includes(f.photoId)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, f.photoId]
                      : selected.filter((id) => id !== f.photoId),
                  )
                }
              />
              <TrashThumbnail key={f.photoId} id={f.photoId} />
              <span className="min-w-0 break-all">
                {f.filename}
                <span className="block text-xs text-muted-foreground">
                  {f.albumName} · Retained until {new Date(f.expiresAt).toLocaleDateString()}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <button
          className="control"
          disabled={loading || busy || page === 1}
          onClick={() => setPage(page - 1)}
        >
          Previous
        </button>
        <span>Page {page}</span>
        <button
          className="control"
          disabled={loading || busy || !more}
          onClick={() => setPage(page + 1)}
        >
          Next
        </button>
      </div>
    </main>
  )
}
