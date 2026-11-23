'use client'
import { clientMutation, clientOperation } from '@/lib/client-operation'
import { isCount, isLocationStatus, isPlaces } from '@/lib/frontend-response-contracts'
import { useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { MapPin } from 'lucide-react'
import type { AlbumPlace } from '@/lib/albums/album-location'

const PlaceMap = dynamic(() => import('./album-location-map'), {
  ssr: false,
  loading: () => <p>Loading map…</p>,
})
interface Status {
  eligible: number
  changes: { id: string; label: string; applied_by: string; applied_at: string; count: number }[]
}
export function AlbumLocation({ eventId, canEdit }: { eventId: number; canEdit: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const router = useRouter()
  const [status, setStatus] = useState<Status | null>(null)
  const [query, setQuery] = useState('')
  const [places, setPlaces] = useState<AlbumPlace[]>([])
  const [selected, setSelected] = useState<AlbumPlace | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [searched, setSearched] = useState(false)
  const url = `/api/events/${eventId}/location`
  const readStatus = () =>
    clientOperation(url, { cache: 'no-store' }, 'Could not load locations', isLocationStatus)
  const refreshStatus = async () => {
    setStatus(await readStatus())
    router.refresh()
  }
  const searchPlaces = (query: string) =>
    clientOperation(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'search', query }),
      },
      'Could not find places',
      isPlaces,
    )
  const changeLocation = (body: object) =>
    clientMutation(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      'Location update failed',
      isCount,
      refreshStatus,
    )
  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Location update failed')
    } finally {
      setBusy(false)
    }
  }
  if (!canEdit) return null
  return (
    <div className="shrink-0">
      <button
        className="album-menu-item"
        onClick={() => {
          dialog.current?.showModal()
          setMessage('')
          setSelected(null)
          void run(async () => setStatus(await readStatus()))
        }}
      >
        <MapPin className="h-4 w-4" /> Set missing locations
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="album-location-title"
        className="m-auto w-[min(640px,calc(100%-2rem))] max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-card text-card-foreground p-6 backdrop:bg-scrim/70"
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id="album-location-title" className="text-xl font-semibold">
            Set missing photo locations
          </h2>
          <button className="control" disabled={busy} onClick={() => dialog.current?.close()}>
            Close
          </button>
        </div>
        <p className="text-sm text-muted-foreground my-4">
          Choose an approximate place for photos without GPS. Existing coordinates and original
          files stay unchanged. Locations are marked as manually assigned.
        </p>
        {error && (
          <p role="alert" className="text-destructive mb-3">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-primary mb-3">
            {message}
          </p>
        )}
        {status && <p className="mb-4">{status.eligible} photos without coordinates</p>}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              setSelected(null)
              setMessage('')
              const data = await searchPlaces(query)
              setPlaces(data.places)
              setSearched(true)
            })
          }}
        >
          <input
            aria-label="Place name"
            placeholder="e.g. San José, Costa Rica"
            maxLength={200}
            value={query}
            disabled={busy}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(null)
              setPlaces([])
              setSearched(false)
            }}
            className="control min-w-0 flex-1"
          />
          <button className="control" disabled={busy || !query.trim()}>
            Search
          </button>
        </form>
        <p className="text-xs text-muted-foreground mt-2">
          Search sends this place name to OpenStreetMap. Use public place names, not private
          addresses.
        </p>
        {searched && !places.length && (
          <p className="my-3">No matching places. Try a nearby town or add the country.</p>
        )}
        <ul className="space-y-2 my-4">
          {places.map((p, i) => (
            <li key={i}>
              <button
                className={`w-full text-left rounded-lg border p-3 text-sm ${selected === p ? 'border-primary bg-primary/10' : 'border-border'}`}
                disabled={busy}
                aria-pressed={selected === p}
                onClick={() => setSelected(p)}
              >
                {p.label}
              </button>
            </li>
          ))}
        </ul>
        {selected && (
          <div className="space-y-3">
            <PlaceMap place={selected} />
            <p className="text-sm">
              Confirm this approximate position: {selected.lat.toFixed(4)},{' '}
              {selected.lng.toFixed(4)}.
            </p>
            <button
              className="control bg-primary text-primary-foreground"
              disabled={busy || !status?.eligible}
              onClick={() =>
                void run(async () => {
                  const result = await changeLocation({ action: 'apply', place: selected })
                  setMessage(`Location applied to ${result.count} photos. My Travels is updated.`)
                  setStatus(await readStatus())
                  setSelected(null)
                  router.refresh()
                })
              }
            >
              {busy ? 'Working…' : `Apply to ${status?.eligible ?? 0} photos without GPS`}
            </button>
          </div>
        )}
        {!!status?.changes.length && (
          <section className="border-t border-border mt-5 pt-4 space-y-3">
            <h3 className="font-semibold">Manually assigned locations</h3>
            {status.changes.map((c) => (
              <div key={c.id} className="flex gap-3 items-start justify-between text-sm">
                <div>
                  <p>{c.label}</p>
                  <p className="text-muted-foreground">
                    {c.count} photos · {c.applied_by} ·{' '}
                    {new Date(c.applied_at).toLocaleDateString()}
                  </p>
                </div>
                <button
                  className="control"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await changeLocation({ action: 'undo', id: c.id })
                      setMessage(`Removed the assigned location from ${result.count} photos.`)
                      setStatus(await readStatus())
                      router.refresh()
                    })
                  }
                >
                  Undo
                </button>
              </div>
            ))}
          </section>
        )}
        <p className="text-xs text-muted-foreground mt-5">
          Place data ©{' '}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            OpenStreetMap contributors
          </a>{' '}
          ·{' '}
          <a
            href="https://operations.osmfoundation.org/policies/nominatim/"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Lookup usage policy
          </a>
        </p>
      </dialog>
    </div>
  )
}
