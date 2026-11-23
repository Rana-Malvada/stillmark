'use client'
import { visibleAccountName } from '@/lib/identity/account-presentation'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, Users, X } from 'lucide-react'
import { useAuth } from './auth-provider'
import { ClientResponseError, readClientResponse } from '@/lib/client-response'
import { createStatusLoader } from '@/lib/status-loader'
import {
  type AlbumSharingData,
  isAlbumSharing,
  isSharingChanged,
} from '@/lib/albums/sharing-response'

export function AlbumSharing(props: { eventId: number; canEdit: boolean }) {
  // An album switch must discard the previous album's access state immediately.
  return <AlbumSharingContent key={`${props.eventId}:${props.canEdit}`} {...props} />
}
function AlbumSharingContent({ eventId, canEdit }: { eventId: number; canEdit: boolean }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const { role } = useAuth()
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<AlbumSharingData | null>(null)
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const writing = useRef(false)
  const mutation = useRef<AbortController | null>(null)
  const loader = useMemo(
    () =>
      createStatusLoader({
        read: async (signal) =>
          readClientResponse(
            await fetch(`/api/events/${eventId}/sharing`, {
              cache: 'no-store',
              signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
            }),
            'Unable to load album access',
            isAlbumSharing,
          ),
        apply: setData,
        loading: setLoading,
      }),
    [eventId],
  )
  const failure = useCallback((error: unknown) => {
    if (error instanceof ClientResponseError && [401, 403, 404].includes(error.status))
      setData(null)
    setError(error instanceof Error ? error.message : 'Unable to load album access')
  }, [])
  useEffect(() => {
    const current = ++generation.current
    if (open) {
      // oxlint-disable-next-line react/set-state-in-effect -- the reset must follow the generation bump in this effect, or a late response from the previous opening could repopulate the dialog
      setData(null)
      setBusy(false)
      setError('')
      loader.activate()
      void loader.refresh().catch((error) => {
        if (generation.current === current) failure(error)
      })
    }
    return () => {
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- a generation counter, not a DOM node: cleanup must bump the live value to fence a pending write
      generation.current++
      loader.cancel()
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- holds the newest write, not a DOM node: cleanup must abort the live one
      mutation.current?.abort()
      writing.current = false
    }
  }, [open, loader, failure])
  async function change(action: string, value?: string) {
    if (writing.current || loading || !data?.canEdit) return
    writing.current = true
    const current = generation.current
    const controller = new AbortController()
    mutation.current = controller
    setBusy(true)
    setError('')
    try {
      const r = await fetch(`/api/events/${eventId}/sharing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, username: value ?? username, visibility: value }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]),
      })
      await readClientResponse(r, 'Unable to update access', isSharingChanged)
      if (generation.current !== current) return
      await loader.refreshAfterMutation()
      if (generation.current !== current) return
      setUsername('')
      if (action === 'transfer') window.location.reload()
    } catch (error) {
      if (generation.current !== current) return
      failure(error)
      // A lost response may follow a committed change. Re-read; never repeat the write.
      try {
        await loader.refreshAfterMutation()
      } catch (refreshError) {
        if (generation.current === current) failure(refreshError)
      }
    } finally {
      if (generation.current === current) {
        writing.current = false
        mutation.current = null
        setBusy(false)
      }
    }
  }
  if (!canEdit && role !== 'admin_readonly') return null
  return (
    <section className="min-w-0 w-full">
      <button
        ref={trigger}
        className="album-menu-item"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <Users className="h-4 w-4" /> Album access
        <ChevronDown className={`ml-auto h-4 w-4 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Album access"
          className="album-access-panel"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setOpen(false)
              trigger.current?.focus()
            }
          }}
        >
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-sm font-semibold">Album access</h2>
            <button
              className="control p-2"
              aria-label="Close album access"
              onClick={() => {
                setOpen(false)
                trigger.current?.focus()
              }}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {error && (
            <button
              className="control"
              disabled={loading}
              onClick={() => {
                setError('')
                void loader.refresh().catch(failure)
              }}
            >
              Retry access
            </button>
          )}
          {!data && !error && (
            <p className="text-muted-foreground" role="status">
              Loading access…
            </p>
          )}
          {data && (
            <>
              <p>
                Owner: {visibleAccountName(data.ownerDisplayName || data.owner)} ·{' '}
                {data.visibility === 'GALLERY'
                  ? 'Shared collection — all gallery users'
                  : 'Private — owner, invited viewers, and main admin'}
              </p>
              <p className="text-sm text-muted-foreground">
                The main admin always has full access.
              </p>
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void change('share')
                }}
              >
                <input
                  aria-label="Gallery username to share with"
                  placeholder="Gallery username"
                  className="control"
                  value={username}
                  maxLength={255}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={busy || loading || !!error || !data.canEdit}
                />
                <button
                  className="primary-button"
                  disabled={busy || loading || !!error || !data.canEdit || !username.trim()}
                >
                  Share as viewer
                </button>
              </form>
              {data.shares.map((s) => (
                <div className="flex gap-3 items-center" key={s.username}>
                  <span>{visibleAccountName(s.displayName || s.username)} · Viewer</span>
                  <button
                    className="control"
                    disabled={busy || loading || !!error || !data.canEdit}
                    onClick={() => void change('revoke', s.username)}
                  >
                    Remove access
                  </button>
                </div>
              ))}
              <div className="flex flex-wrap gap-3 border-t pt-3">
                <button
                  className="control"
                  disabled={busy || loading || !!error || !data.canEdit}
                  onClick={() => {
                    if (
                      data.visibility === 'GALLERY' ||
                      window.confirm(
                        'Share this album with everyone who is signed in to the gallery? You can make it private again at any time.',
                      )
                    )
                      void change(
                        'visibility',
                        data.visibility === 'GALLERY' ? 'PRIVATE' : 'GALLERY',
                      )
                  }}
                >
                  {data.visibility === 'GALLERY' ? 'Make private' : 'Share with all gallery users'}
                </button>
              </div>
              {(data.mainAdmin || role === 'admin_readonly') && (
                <div className="flex flex-wrap gap-3 border-t pt-3">
                  <button
                    className="control"
                    disabled={busy || loading || !!error || !data.mainAdmin || !username.trim()}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Transfer ownership to ${username}? The previous owner will need a share to retain access.`,
                        )
                      )
                        void change('transfer')
                    }}
                  >
                    Transfer to entered username
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
