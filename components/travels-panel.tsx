'use client'
import { Thumbnail } from '@/components/thumbnail'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { ArrowUpRight, Compass, FolderOpen, Globe2, Images, MapPin } from 'lucide-react'
import { travelOverview } from '@/lib/travel/travel-overview'
import type { TravelStop } from '@/lib/travel/travels'
import { readClientResponse } from '@/lib/client-response'
import { isPlaceLookup, isTravelOverview } from '@/lib/travel/travel-response'

const Map = dynamic(() => import('./travel-map'), {
  ssr: false,
  loading: () => (
    <div className="h-[70dvh] bg-muted animate-pulse rounded-2xl" aria-label="Loading map" />
  ),
})
const empty: TravelStop[] = []
export function TravelsPanel() {
  const [scope, setScope] = useState<'mine' | 'accessible'>('mine')
  const [year, setYear] = useState('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [limit, setLimit] = useState(36)
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['travels', scope],
    queryFn: async ({ signal }) => {
      const r = await fetch(`/api/travels?scope=${scope}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
      })
      return readClientResponse(r, 'Unable to load travels', isTravelOverview)
    },
    staleTime: 30_000,
  })
  const [lookingUp, setLookingUp] = useState(false)
  const [lookupMessage, setLookupMessage] = useState('')
  const lookupController = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      lookupController.current?.abort()
    },
    [],
  )
  const overview = useMemo(() => travelOverview(data?.stops ?? empty, year), [data, year])
  const retryNames = overview.lookupPlaces.length === 0 && overview.unnamedPlaces.length > 0
  const missingNames = retryNames ? overview.unnamedPlaces : overview.lookupPlaces
  async function findNames() {
    if (lookupController.current || missingNames.length === 0) return
    const controller = new AbortController()
    lookupController.current = controller
    setLookingUp(true)
    setLookupMessage('Finding place names…')
    let found = 0
    let checked = 0
    let reused = 0
    try {
      for (const area of missingNames.slice(0, 12)) {
        if (controller.signal.aborted) break
        const response = await fetch('/api/travels/place-name', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ area: area.id, retry: retryNames }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
        })
        const body = await readClientResponse(response, 'Place lookup unavailable', isPlaceLookup)
        if (controller.signal.aborted) break
        checked++
        if (body.name?.label) {
          found++
          if (body.cached) reused++
        }
        setLookupMessage(`Checked ${checked} of ${Math.min(12, missingNames.length)} areas…`)
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', done)
            resolve()
          }
          const timer = setTimeout(done, 2100)
          controller.signal.addEventListener('abort', done, { once: true })
        })
      }
      if (!controller.signal.aborted)
        setLookupMessage(
          `${found - reused} new place names saved. ${reused ? `${reused} already saved. ` : ''}${checked - found ? `${checked - found} areas have no name available yet.` : ''}`,
        )
    } catch (error) {
      if (!controller.signal.aborted)
        setLookupMessage(error instanceof Error ? error.message : 'Place lookup unavailable')
    } finally {
      if (!controller.signal.aborted) {
        await refetch()
        if (!controller.signal.aborted) setLookingUp(false)
      }
      if (lookupController.current === controller) lookupController.current = null
    }
  }
  const place = overview.places.find((p) => p.id === selected)
  const albums = useMemo(() => {
    const groups = new globalThis.Map<
      number,
      { id: number; name: string; count: number; photoId: number; thumbnail: string | null }
    >()
    for (const stop of place?.stops ?? []) {
      const existing = groups.get(stop.eventId)
      if (existing) existing.count += stop.count
      else
        groups.set(stop.eventId, {
          id: stop.eventId,
          name: stop.album,
          count: stop.count,
          photoId: stop.photoId,
          thumbnail: stop.thumbnail,
        })
    }
    return [...groups.values()]
  }, [place])
  return (
    <main className="w-full min-w-0 px-5 sm:px-8 py-5 space-y-4">
      <h1 className="text-xl font-semibold">Places</h1>
      <div className="travel-filters grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-3 sm:max-w-lg">
        <label className="min-w-0 flex flex-col gap-1.5 text-sm font-medium">
          Explore
          <select
            disabled={lookingUp}
            aria-label="Album scope"
            className="control w-full min-w-0 !min-h-11 !text-base"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as typeof scope)
              setYear('all')
              setSelected(null)
              setLimit(12)
            }}
          >
            <option value="mine">My albums</option>
            <option value="accessible">Albums I can access</option>
          </select>
        </label>
        <label className="min-w-0 flex flex-col gap-1.5 text-sm font-medium">
          Year
          <select
            disabled={lookingUp}
            aria-label="Travel year"
            className="control w-full min-w-0 !min-h-11 !text-base"
            value={year}
            onChange={(e) => {
              setYear(e.target.value)
              setSelected(null)
              setLimit(12)
            }}
          >
            <option value="all">All years</option>
            {overview.years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
            {overview.undated && <option value="undated">Date unknown</option>}
          </select>
        </label>
      </div>
      {isPending ? (
        <p role="status" className="text-muted-foreground py-16">
          Gathering your travels…
        </p>
      ) : error ? (
        <div role="alert" className="rounded-xl border p-6">
          <p>Unable to load your travels.</p>
          <button className="control mt-3" onClick={() => void refetch()}>
            Try again
          </button>
        </div>
      ) : (
        <>
          {overview.places.length === 0 ? (
            <section className="rounded-2xl border p-10 sm:p-16 text-center space-y-4">
              <Compass size={40} className="mx-auto text-primary" />
              <h2 className="text-xl font-semibold">
                {overview.total
                  ? 'Your memories need a place on the map'
                  : 'Your next chapter starts here'}
              </h2>
              <p className="text-sm text-muted-foreground max-w-lg mx-auto">
                {overview.total
                  ? 'These files have no valid GPS coordinates. Photos and videos with saved location information will appear here automatically.'
                  : 'No photos or videos match this view. Choose another year, explore accessible albums, or add an album of your own.'}
              </p>
              <Link href="/my-albums" className="control inline-flex">
                Browse My Albums
              </Link>
            </section>
          ) : (
            <>
              <section className="rounded-2xl border bg-card overflow-hidden">
                <div className="px-3 py-2 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">
                      {place ? place.label : `${overview.places.length.toLocaleString()} places`}
                    </h2>
                    <p className="text-xs text-muted-foreground mt-1">
                      Pinch to zoom · Tap a group to explore
                    </p>
                  </div>
                  {place && (
                    <button className="control" onClick={() => setSelected(null)}>
                      Show all places
                    </button>
                  )}
                </div>
                <div className="relative z-0">
                  <Map
                    scope={scope}
                    year={year}
                    places={overview.places}
                    selected={selected}
                    onSelect={setSelected}
                  />
                </div>
              </section>
              {place && (
                <section
                  aria-live="polite"
                  className="rounded-2xl border border-primary/40 bg-card p-5 space-y-4"
                >
                  <div className="flex justify-between items-start gap-4">
                    <div>
                      <p className="eyebrow mb-2">Explore this area</p>
                      <h2 className="text-xl font-semibold">{place.label}</h2>
                      <p className="text-sm text-muted-foreground mt-1">
                        {place.count} files across {albums.length}{' '}
                        {albums.length === 1 ? 'album' : 'albums'}
                      </p>
                    </div>
                    <button className="control" onClick={() => setSelected(null)}>
                      Close
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {albums.map((a) => (
                      <div key={a.id} className="flex gap-3 rounded-xl border p-3">
                        <Link
                          href={`/photos/${a.photoId}`}
                          aria-label={`Open a photo from ${a.name}`}
                          className="h-20 w-20 shrink-0 rounded-lg bg-muted overflow-hidden"
                        >
                          {a.thumbnail ? (
                            <Thumbnail
                              src={`/api/images?path=${encodeURIComponent(a.thumbnail)}`}
                              alt=""
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <Images className="m-6" />
                          )}
                        </Link>
                        <div className="min-w-0 py-1">
                          <Link
                            href={`/events/${a.id}`}
                            className="font-semibold hover:text-primary break-words"
                          >
                            {a.name} <ArrowUpRight className="inline" size={14} />
                          </Link>
                          <p className="text-xs text-muted-foreground mt-2">
                            {a.count} files in this area
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold">Explore your places</h2>
                  <span className="text-xs text-muted-foreground">
                    {overview.places.length} mapped areas
                  </span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-2">
                  {overview.places.slice(0, limit).map((p) => (
                    <button
                      key={p.id}
                      aria-pressed={p.id === selected}
                      onClick={() => setSelected(p.id)}
                      className={`min-w-0 text-left rounded-lg border px-3 py-2 transition-colors hover:bg-muted ${p.id === selected ? 'border-primary bg-primary/5' : 'bg-card'}`}
                    >
                      <span className="block text-sm font-semibold leading-snug break-words">
                        {p.label}
                      </span>
                      <span className="block text-xs text-muted-foreground mt-1">
                        {p.count} files · {new Set(p.stops.map((s) => s.eventId)).size}{' '}
                        {new Set(p.stops.map((s) => s.eventId)).size === 1 ? 'album' : 'albums'}
                      </span>
                    </button>
                  ))}
                </div>
                {limit < overview.places.length && (
                  <button className="control" onClick={() => setLimit((n) => n + 36)}>
                    Show more places
                  </button>
                )}
              </section>
            </>
          )}
          <details className="rounded-xl border p-4">
            <summary className="cursor-pointer font-medium">Map details &amp; place names</summary>
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                {[
                  { label: 'Mapped areas', value: overview.places.length, Icon: MapPin },
                  { label: 'Countries recorded', value: overview.countries, Icon: Globe2 },
                  { label: 'Located photos & videos', value: overview.mapped, Icon: Images },
                  { label: 'Albums in this view', value: overview.albums, Icon: FolderOpen },
                ].map(({ label, value, Icon }) => (
                  <div
                    key={label}
                    className="rounded-lg border bg-card px-3 py-2 flex items-center gap-3 min-w-0"
                  >
                    <Icon size={16} className="text-primary shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xl font-semibold tabular-nums">{value.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground">{label}</p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-sm text-muted-foreground" role="status">
                {overview.namedPlaces.toLocaleString()} of {overview.places.length.toLocaleString()}{' '}
                mapped areas named · {overview.unnamedPlaces.length.toLocaleString()} still unnamed
              </p>
              <div className="rounded-xl border p-4 flex flex-wrap items-center gap-4">
                <button
                  className="control disabled:opacity-50"
                  disabled={lookingUp || missingNames.length === 0}
                  aria-describedby="place-name-help"
                  onClick={() => void findNames()}
                >
                  {lookingUp
                    ? 'Finding names…'
                    : missingNames.length > 0
                      ? `${retryNames ? 'Retry unnamed areas' : 'Find place names'} (${missingNames.length} remaining)`
                      : 'Find place names'}
                </button>
                <p id="place-name-help" className="text-xs text-muted-foreground flex-1 min-w-48">
                  {missingNames.length > 0
                    ? retryNames
                      ? 'These areas have no saved place name. You can retry them; provider rate limits still apply.'
                      : 'Each click names up to 12 existing mapped areas. Only approximate coordinates are sent to OpenStreetMap. Names are saved for future visits.'
                    : overview.unnamedPlaces.length > 0
                      ? 'These areas have no saved place name.'
                      : overview.places.length > 0
                        ? 'All mapped areas in this view already have place names.'
                        : 'No mapped areas in this view. Choose another year or album scope, or add photos with GPS locations.'}
                </p>
              </div>
              {lookupMessage && (
                <p role="status" className="text-sm text-muted-foreground">
                  {lookupMessage}
                </p>
              )}
            </div>
          </details>
          <p className="text-xs text-muted-foreground">
            Place lookup data ©{' '}
            <a
              className="underline"
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer"
            >
              OpenStreetMap contributors
            </a>{' '}
            ·{' '}
            <a
              className="underline"
              href="https://operations.osmfoundation.org/policies/nominatim/"
              target="_blank"
              rel="noreferrer"
            >
              Lookup usage policy
            </a>
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {overview.total - overview.mapped} of {overview.total} files have no GPS location in
            this view. Map dots group nearby files when zoomed out and keep nearby positions grouped
            at neighborhood zoom for smoother browsing. Place cards summarize approximate areas.
            Names come from saved metadata or approximate place lookups and may be incomplete. Years
            use capture dates in UTC, falling back to the album year when missing. Files with
            neither stay under Date unknown.
          </p>
        </>
      )}
    </main>
  )
}
