'use client'
import { visibleAccountName } from '@/lib/identity/account-presentation'
import Link from 'next/link'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ClientResponseError, readClientResponse } from '@/lib/client-response'
import { createStatusLoader } from '@/lib/status-loader'
import {
  type SharedLinkEntry as Entry,
  isSharedLinks,
  isSharingChanged,
  type SharedLinksData as Result,
} from '@/lib/albums/sharing-response'

export function SharedLinksPanel() {
  const [snapshot, setSnapshot] = useState<{ scope: string; value: Result } | null>(null)
  const [owner, setOwner] = useState('')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(0)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const scope = `${owner}\0${status}\0${page}`
  const data = snapshot?.scope === scope ? snapshot.value : null
  const currentScope = useRef(scope)
  const mounted = useRef(false)
  const writing = useRef(false)
  const mutation = useRef<AbortController | null>(null)
  const loader = useMemo(
    () =>
      createStatusLoader({
        read: async (signal) =>
          readClientResponse(
            await fetch(
              `/api/shared-links?${new URLSearchParams({ owner, status, page: String(page) })}`,
              {
                cache: 'no-store',
                signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
              },
            ),
            'Unable to load shared links',
            isSharedLinks,
          ),
        apply: (value) => setSnapshot({ scope, value }),
        loading: setLoading,
      }),
    [owner, status, page, scope],
  )
  const currentLoader = useRef(loader)
  // Committed before any response can be handled, so late results for other filters are dropped.
  useLayoutEffect(() => {
    currentScope.current = scope
    currentLoader.current = loader
  })
  const failure = useCallback((error: unknown) => {
    if (error instanceof ClientResponseError && [401, 403, 404].includes(error.status))
      setSnapshot(null)
    setError(error instanceof Error ? error.message : 'Unable to load shared links')
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      mutation.current?.abort()
    }
  }, [])
  useEffect(() => {
    loader.activate()
    // oxlint-disable-next-line react/set-state-in-effect -- the clear must run with the refresh that supersedes the previous read, or its late failure would stay on screen (a success never clears the error)
    setError('')
    void loader.refresh().catch((error) => {
      if (mounted.current && currentScope.current === scope) failure(error)
    })
    return () => loader.cancel()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- revision is the Refresh trigger
  }, [loader, revision, scope, failure])
  async function revoke(l: Entry) {
    if (writing.current || loading || error || !l.canRevoke) return
    if (
      !window.confirm(
        `Revoke this link to “${l.event_name}”? Anyone using it will lose access. Already loaded or saved media cannot be recalled.`,
      )
    )
      return
    writing.current = true
    const controller = new AbortController()
    mutation.current = controller
    setBusy(l.id)
    setError('')
    try {
      const response = await fetch(`/api/events/${l.event_id}/links`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: l.id }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]),
      })
      await readClientResponse(response, 'Unable to revoke link', isSharingChanged)
    } catch (error) {
      if (mounted.current && currentScope.current === scope) failure(error)
    } finally {
      if (mounted.current) {
        // Also reconcile uncertain writes and any filters changed while the write ran.
        const afterScope = currentScope.current
        try {
          await currentLoader.current.refreshAfterMutation()
        } catch (error) {
          if (mounted.current && currentScope.current === afterScope) failure(error)
        }
        if (mounted.current) {
          writing.current = false
          mutation.current = null
          setBusy('')
        }
      }
    }
  }
  return (
    <main className="w-full min-w-0 px-5 sm:px-8 py-6">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <h1 className="text-2xl font-semibold">Shared Links</h1>
        <button className="control" disabled={loading} onClick={() => setRevision((v) => v + 1)}>
          Refresh
        </button>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Manage links that let people view albums without signing in. Create new links from an
        album’s More menu. Link URLs are shown only when created.
      </p>
      <div className="grid grid-cols-1 min-[360px]:grid-cols-2 sm:flex sm:flex-wrap items-end gap-3 my-4">
        {data?.canFilterOwners && (
          <label className="flex min-w-0 flex-col gap-1.5 text-sm">
            User
            <select
              className="control w-full min-w-0 sm:w-auto sm:max-w-72"
              value={owner}
              onChange={(e) => {
                setOwner(e.target.value)
                setPage(0)
              }}
            >
              <option value="">All users</option>
              {data.owners.map((u) => (
                <option key={u} value={u}>
                  {visibleAccountName(data.ownerLabels?.[u] || u)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex min-w-0 flex-col gap-1.5 text-sm">
          Status
          <select
            className="control w-full min-w-0 sm:w-auto sm:max-w-72"
            aria-label="Status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setPage(0)
            }}
          >
            {['all', 'active', 'expired', 'revoked', 'invalidated'].map((s) => (
              <option key={s} value={s}>
                {s === 'invalidated' ? 'Ownership changed' : s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p role="alert" className="text-destructive my-3">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">Loading links…</p>
      ) : (
        data && (
          <>
            <div className="space-y-3">
              {!data.links.length && (
                <p className="text-muted-foreground">No shared links match these filters.</p>
              )}
              {data.links.map((l) => (
                <article
                  key={l.id}
                  className="rounded-xl border border-border bg-card p-4 grid min-w-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto] items-center gap-4"
                >
                  <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
                    <Link
                      href={`/events/${l.event_id}`}
                      className="font-semibold hover:underline break-words"
                    >
                      {l.event_name}
                    </Link>
                    <p className="text-sm text-muted-foreground">
                      Owner: {visibleAccountName(l.owner_display_name || l.owner_username)} ·
                      Created by {visibleAccountName(l.creator_display_name || l.created_by)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Created {new Date(l.created_at).toLocaleString()} · Expires{' '}
                      {new Date(l.expires_at).toLocaleString()}
                    </p>
                    <p className="text-sm">
                      {l.status === 'invalidated'
                        ? 'Ownership changed'
                        : l.status[0].toUpperCase() + l.status.slice(1)}{' '}
                      ·{' '}
                      {l.selected_count == null
                        ? 'Whole album'
                        : `${l.selected_count} selected files`}{' '}
                      · {l.allow_downloads ? 'Original downloads allowed' : 'View only'} ·{' '}
                      {l.include_location ? 'Location included' : 'Location hidden'} ·{' '}
                      {l.include_people ? 'Names included' : 'Names hidden'}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 w-full lg:flex lg:w-auto">
                    <Link
                      className="control inline-flex items-center justify-center text-center"
                      href={`/events/${l.event_id}`}
                    >
                      Open album
                    </Link>
                    {l.status === 'active' && l.canRevoke && (
                      <button
                        className="control inline-flex items-center justify-center text-center"
                        disabled={!!busy || !!error}
                        onClick={() => void revoke(l)}
                      >
                        {busy === l.id ? 'Revoking…' : 'Revoke'}
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
            <div className="grid grid-cols-[1fr_auto_1fr] sm:flex items-center gap-3 mt-4">
              <button
                className="control"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span className="text-sm">Page {page + 1}</span>
              <button
                className="control"
                disabled={!data.hasMore}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </>
        )
      )}
    </main>
  )
}
