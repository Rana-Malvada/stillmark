'use client'
import { useDialogViewport } from './use-dialog-viewport'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ClientResponseError, readClientResponse } from '@/lib/client-response'
import { createStatusLoader } from '@/lib/status-loader'
import {
  isPublicLinkCreated,
  isPublicLinks,
  isSharingChanged,
  type PublicLinkInfo,
} from '@/lib/albums/sharing-response'
import { Link2 } from 'lucide-react'

type Props = { eventId: number; canEdit: boolean; photoIds?: number[]; className?: string }
export function AlbumPublicLinks(props: Props) {
  return <AlbumPublicLinksContent key={`${props.eventId}:${props.canEdit}`} {...props} />
}
function AlbumPublicLinksContent({
  eventId,
  canEdit,
  photoIds,
  className = 'album-menu-item',
}: Props) {
  const headingId = useId()
  const [selection, setSelection] = useState<number[] | undefined>()
  const dialog = useRef<HTMLDialogElement>(null)
  const [links, setLinks] = useState<PublicLinkInfo[]>([])
  const [duration, setDuration] = useState('7')
  const [custom, setCustom] = useState('')
  const [downloads, setDownloads] = useState(false)
  const [includeLocation, setIncludeLocation] = useState(false)
  const [includePeople, setIncludePeople] = useState(false)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const endpoint = `/api/events/${eventId}/links`
  const generation = useRef(0)
  const opened = useRef(false)
  const writing = useRef(false)
  const mutation = useRef<AbortController | null>(null)
  const [loading, setLoading] = useState(false)
  // Expiry is judged against the clock as of the latest link list, not on every render.
  const [checkedAt, setCheckedAt] = useState(() => Date.now())
  const showLinks = useCallback((value: Parameters<typeof setLinks>[0]) => {
    setLinks(value)
    setCheckedAt(Date.now())
  }, [])
  const loader = useMemo(
    () =>
      createStatusLoader({
        read: async (signal) =>
          readClientResponse(
            await fetch(endpoint, {
              cache: 'no-store',
              signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
            }),
            'Unable to load sharing links',
            isPublicLinks,
          ),
        apply: showLinks,
        loading: setLoading,
      }),
    [endpoint, showLinks],
  )
  const invalidate = useCallback(() => {
    opened.current = false
    generation.current++
    loader.cancel()
    mutation.current?.abort()
    mutation.current = null
    writing.current = false
  }, [loader])
  useEffect(() => invalidate, [invalidate])
  function failure(error: unknown) {
    if (error instanceof ClientResponseError && [401, 403, 404].includes(error.status)) {
      setLinks([])
      setUrl('')
    }
    setError(error instanceof Error ? error.message : 'Unable to update sharing links')
  }
  async function refresh() {
    const current = generation.current
    setError('')
    try {
      await loader.refresh()
    } catch (error) {
      if (opened.current && generation.current === current) failure(error)
    }
  }
  async function change(method: 'POST' | 'DELETE', body: object) {
    if (writing.current || loading || !opened.current) return
    writing.current = true
    const current = generation.current
    const controller = new AbortController()
    mutation.current = controller
    setBusy(true)
    setError('')
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]),
      })
      if (method === 'POST') {
        const created = await readClientResponse(
          response,
          'Unable to create sharing link',
          isPublicLinkCreated,
        )
        if (!opened.current || generation.current !== current) return
        setUrl(window.location.origin + created.path)
        setCopied(false)
      } else {
        await readClientResponse(response, 'Unable to revoke sharing link', isSharingChanged)
        if (!opened.current || generation.current !== current) return
        setUrl('')
      }
      await loader.refreshAfterMutation()
    } catch (error) {
      if (!opened.current || generation.current !== current) return
      failure(error)
      // A response can be lost after commit. Reconcile once without repeating the mutation.
      try {
        await loader.refreshAfterMutation()
      } catch (refreshError) {
        if (opened.current && generation.current === current) failure(refreshError)
      }
    } finally {
      if (opened.current && generation.current === current) {
        writing.current = false
        mutation.current = null
        setBusy(false)
      }
    }
  }
  useDialogViewport(dialog)
  if (!canEdit) return null
  return (
    <div>
      <button
        className={className}
        disabled={busy || (photoIds !== undefined && !photoIds.length)}
        onClick={() => {
          invalidate()
          opened.current = true
          loader.activate()
          setLinks([])
          setBusy(false)
          setSelection(photoIds ? [...photoIds] : undefined)
          setUrl('')
          setCopied(false)
          dialog.current?.showModal()
          void refresh()
        }}
      >
        <Link2 className="h-4 w-4" /> {photoIds ? 'Share selected' : 'Share whole album by link'}
      </button>
      <dialog
        ref={dialog}
        onClose={() => {
          invalidate()
          setBusy(false)
          setLoading(false)
        }}
        onCancel={() => {
          invalidate()
          setBusy(false)
          setLoading(false)
        }}
        className="app-dialog m-auto w-[min(36rem,calc(100%-2rem))] max-h-[85dvh] overflow-hidden rounded-xl border border-border bg-card text-foreground p-0 backdrop:bg-scrim/70"
        aria-labelledby={headingId}
      >
        <div className="flex items-center justify-between gap-3 p-4 border-b shrink-0">
          <h2 id={headingId} className="text-lg font-semibold">
            <Link2 className="h-4 w-4" /> Share by link
          </h2>
          <button
            className="control"
            onClick={() => {
              invalidate()
              dialog.current?.close()
            }}
          >
            Close
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-4">
          <p className="my-3 text-sm text-muted-foreground">
            Anyone with the link can view{' '}
            {selection ? `these ${selection.length} selected files` : 'this whole album'} without
            signing in until it expires or you revoke it. Links can be forwarded. Already loaded or
            saved media cannot be recalled.
          </p>
          <p className="mb-3 text-sm font-medium">
            {selection
              ? 'Only this selection is shared. Later uploads are not added.'
              : 'All album files are shared, including later uploads.'}
          </p>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {error && (
            <button className="control" disabled={busy || loading} onClick={() => void refresh()}>
              Retry links
            </button>
          )}
          {loading && <p role="status">Loading sharing links…</p>}
          <form
            id={`${headingId}-form`}
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              try {
                const expiresAt =
                  duration === 'custom'
                    ? new Date(custom).toISOString()
                    : new Date(Date.now() + Number(duration) * 86400000).toISOString()
                void change('POST', {
                  expiresAt,
                  allowDownloads: downloads,
                  includeLocation,
                  includePeople,
                  ...(selection ? { photoIds: selection } : {}),
                })
              } catch (error) {
                failure(error)
              }
            }}
          >
            <label className="block">
              Expires{' '}
              <select
                className="control"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              >
                <option value="1">24 hours</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="custom">Custom date (up to 90 days)</option>
              </select>
            </label>
            {duration === 'custom' && (
              <input
                required
                aria-label="Expiration date and time"
                type="datetime-local"
                className="control"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
              />
            )}
            <label className="flex gap-2 items-center min-h-11">
              <input
                type="checkbox"
                checked={downloads}
                onChange={(e) => setDownloads(e.target.checked)}
              />
              Allow original and {selection ? 'selected-files' : 'full-album'} ZIP downloads
            </label>
            <p className="text-xs text-muted-foreground">
              Even with downloads off, viewers can save or capture displayed photos and videos.
            </p>
            <label className="flex gap-2 items-center min-h-11">
              <input
                type="checkbox"
                checked={includeLocation}
                onChange={(e) => setIncludeLocation(e.target.checked)}
              />
              Include location information
            </label>
            <p className="text-xs text-muted-foreground">
              Shows saved locations and a GPS map in photo details. Original downloads may still
              contain GPS metadata when this is off.
            </p>
            <label className="flex gap-2 items-center min-h-11">
              <input
                type="checkbox"
                checked={includePeople}
                onChange={(e) => setIncludePeople(e.target.checked)}
              />
              Include people’s names
            </label>
            <p className="text-xs text-muted-foreground">
              Viewers can show or hide names on photos. Only identified, non-hidden people are
              included.
            </p>
          </form>
          {url && (
            <div className="my-4 space-y-2">
              <label className="block text-sm">
                Copy this link now; its secret is not stored.
                <input
                  readOnly
                  value={url}
                  onFocus={(e) => e.target.select()}
                  className="control w-full"
                />
              </label>
            </div>
          )}
          <h3 className="mt-5 mb-2 font-semibold">Created links</h3>
          {!links.length && <p className="text-sm">No sharing links yet.</p>}
          {links.map((l) => (
            <div key={l.id} className="border-t py-3 text-sm flex flex-wrap items-center gap-3">
              <span>
                {l.selected_count == null ? 'Whole album' : `${l.selected_count} selected files`} ·
                Created {new Date(l.created_at).toLocaleString()}
                <br />
                Expires {new Date(l.expires_at).toLocaleString()} ·{' '}
                {l.allow_downloads ? 'Downloads allowed' : 'View only'} ·{' '}
                {l.include_location ? 'Location included' : 'Location hidden'} ·{' '}
                {l.include_people ? 'Names included' : 'Names hidden'}
              </span>
              {l.revoked_at ? (
                <span>Revoked</span>
              ) : new Date(l.expires_at).getTime() <= checkedAt ? (
                <span>Expired</span>
              ) : (
                <button
                  className="control"
                  disabled={busy || loading || !!error}
                  onClick={() => void change('DELETE', { id: l.id })}
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="border-t bg-card p-4 shrink-0 flex flex-wrap gap-2 dialog-footer">
          <button
            form={`${headingId}-form`}
            disabled={busy || loading || !!error}
            className="primary-button"
          >
            {busy ? 'Working…' : 'Create link'}
          </button>
          {url && (
            <button
              className="control"
              onClick={() =>
                void navigator.clipboard
                  .writeText(url)
                  .then(() => setCopied(true))
                  .catch(() => setError('Select the link above and copy it manually.'))
              }
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          )}
        </div>
      </dialog>
    </div>
  )
}
