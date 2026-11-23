'use client'
import { useMapColors } from './use-map-colors'
import { useAuth } from './auth-provider'
import { createViewportCache } from '@/lib/travel/travel-viewport-cache'
import { createTravelView } from '@/lib/travel/travel-map-view'
import { ClientResponseError, readClientResponse } from '@/lib/client-response'
import { isTravelViewport } from '@/lib/travel/travel-response'
import { BasemapLayer } from './basemap-layer'
import { MapGestures } from './map-gestures'
import { type RefObject, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { TRAVEL_MAX_ZOOM, type TravelCluster } from '@/lib/travel/travel-clusters'
import { CircleMarker, MapContainer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import type { TravelPlace } from '@/lib/travel/travel-overview'
import { Ellipsis, MapPin, Maximize, Minimize } from 'lucide-react'
import 'leaflet/dist/leaflet.css'

function View({
  places,
  selected,
  mapSelectionRef,
  reset,
}: {
  places: TravelPlace[]
  selected: string | null
  reset: number
  mapSelectionRef: RefObject<boolean>
}) {
  const map = useMap()
  const view = useRef<ReturnType<typeof createTravelView> | null>(null)
  useEffect(() => {
    const controller = createTravelView(map, [])
    view.current = controller
    // Leaflet invalidation changes layout. Run it outside ResizeObserver delivery
    // so WebKit can finish the current layout instead of entering a resize loop.
    let frame: number | undefined
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        controller.resize()
      })
    })
    observer.observe(map.getContainer())
    return () => {
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
      controller.dispose()
      view.current = null
    }
  }, [map])
  useEffect(() => {
    view.current?.updatePlaces(places)
  }, [places])
  // Reads the newest places without re-centring the map every time they refresh.
  const showSelection = useEffectEvent((id: string | null) => {
    const place = places.find((p) => p.id === id)
    if (place) view.current?.focus(place)
    else view.current?.showAll()
  })
  useEffect(() => {
    if (mapSelectionRef.current) {
      mapSelectionRef.current = false
      return
    }
    showSelection(selected)
  }, [selected, mapSelectionRef])
  useEffect(() => {
    if (reset) view.current?.showAll()
  }, [reset])
  return null
}
function Dots({
  scope,
  year,
  onSelect,
}: {
  scope: 'mine' | 'accessible'
  year: string
  onSelect: (id: string) => void
}) {
  const [viewport, setViewport] = useState(0)
  const [visible, setVisible] = useState<TravelCluster[]>([])
  const [error, setError] = useState(false)
  const cache = useRef(createViewportCache<TravelCluster[]>())
  // Keep the listener attached when View's effects call fitBounds on reset.
  // A new handlers object would detach it before those sibling effects run.
  const mapEvents = useMemo(() => ({ moveend: () => setViewport((v) => v + 1) }), [])
  const map = useMapEvents(mapEvents)
  const colors = useMapColors()
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      const b = map.getBounds().pad(0.1)
      const west = b.getWest()
      const east = b.getEast()
      // Leaflet permits wrapped worlds. A crossing viewport queries the whole longitude range.
      const wrap = (n: number) => ((((n + 180) % 360) + 360) % 360) - 180
      const w = wrap(west)
      const e = wrap(east)
      const cross = east - west >= 360 || w >= e
      const params = new URLSearchParams({
        view: 'viewport',
        scope,
        year,
        south: Math.max(-90, b.getSouth()).toFixed(6),
        north: Math.min(90, b.getNorth()).toFixed(6),
        west: (cross ? -180 : w).toFixed(6),
        east: (cross ? 180 : e).toFixed(6),
        zoom: String(Math.floor(Math.min(TRAVEL_MAX_ZOOM, Math.max(0, map.getZoom())))),
      })
      try {
        const cached = cache.current.get(params.toString())
        if (cached) {
          setVisible(cached)
          setError(false)
          return
        }
        const response = await fetch(`/api/travels?${params}`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
        })
        const data = await readClientResponse(
          response,
          'Unable to update locations',
          isTravelViewport,
        )
        if (!controller.signal.aborted) {
          cache.current.put(params.toString(), data.clusters)
          setVisible(data.clusters)
          setError(false)
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          if (reason instanceof ClientResponseError && [401, 403].includes(reason.status)) {
            cache.current.clear()
            setVisible([])
          }
          setError(true)
        }
      }
    }, 150)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- viewport counts map moves; the bounds are read from Leaflet, which is not reactive
  }, [map, scope, year, viewport])
  return (
    <>
      {error && (
        <div
          className="absolute bottom-7 left-3 z-[1000] rounded border bg-background px-3 py-2 text-xs"
          role="status"
        >
          Unable to update locations. {visible.length > 0 ? 'Showing previous results. ' : ''}
          <button type="button" className="underline" onClick={() => setViewport((v) => v + 1)}>
            Retry
          </button>
        </div>
      )}
      {colors &&
        visible.map((p) => (
          <CircleMarker
            key={p.id}
            center={[p.lat, p.lng]}
            radius={p.count > 999 ? 24 : p.count > 99 ? 21 : 18}
            pathOptions={{ ...colors, fillOpacity: 0.95, weight: 2 }}
            eventHandlers={{
              click: () => {
                if (p.points > 1 && map.getZoom() < TRAVEL_MAX_ZOOM)
                  map.setView(
                    [p.lat, p.lng],
                    Math.min(TRAVEL_MAX_ZOOM, Math.floor(map.getZoom()) + 2),
                  )
                else onSelect(p.areaId)
              },
            }}
          >
            <Tooltip permanent direction="center" className="travel-count" opacity={1}>
              {p.count.toLocaleString()}
            </Tooltip>
          </CircleMarker>
        ))}
    </>
  )
}
export default function TravelMap({
  places,
  selected,
  onSelect,
  scope,
  year,
}: {
  places: TravelPlace[]
  selected: string | null
  onSelect: (id: string) => void
  scope: 'mine' | 'accessible'
  year: string
}) {
  const { username } = useAuth()
  const mapSelection = useRef(false)
  const container = useRef<HTMLDialogElement>(null)
  const toggle = useRef<HTMLDetailsElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [reset, setReset] = useState(0)
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (toggle.current && !toggle.current.contains(event.target as Node))
        toggle.current.removeAttribute('open')
    }
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && toggle.current?.open) {
        event.preventDefault()
        toggle.current.removeAttribute('open')
        toggle.current.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeEscape, true)
    }
  }, [])
  function changeFullscreen(expanded: boolean) {
    const dialog = container.current
    if (!dialog) return
    dialog.close()
    if (expanded) dialog.showModal()
    else dialog.show()
    setFullscreen(expanded)
    toggle.current?.removeAttribute('open')
    toggle.current?.querySelector('summary')?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (!fullscreen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [fullscreen])
  return (
    <dialog
      ref={container}
      open
      aria-label="My travels map"
      onCancel={(event) => {
        event.preventDefault()
        changeFullscreen(false)
      }}
      className={`m-0 max-w-none max-h-none w-full border-0 p-0 bg-background text-foreground ${fullscreen ? 'fixed inset-0 h-dvh' : 'relative aspect-[3/2] h-auto sm:aspect-auto sm:h-[70dvh]'}`}
    >
      <details ref={toggle} className="absolute right-3 top-3 z-[1000]">
        <summary
          aria-label="Map options"
          title="Map options"
          className="list-none cursor-pointer rounded-lg border bg-background p-2.5 shadow-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden"
        >
          <Ellipsis size={20} />
        </summary>
        <div className="absolute right-0 mt-2 w-48 rounded-lg border bg-background p-1 shadow-lg">
          <button
            type="button"
            onClick={() => changeFullscreen(!fullscreen)}
            className="flex w-full items-center gap-2 rounded px-3 py-2.5 text-left text-sm hover:bg-muted"
          >
            {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
            {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </button>
          <button
            type="button"
            onClick={() => {
              setReset((n) => n + 1)
              toggle.current?.removeAttribute('open')
              toggle.current?.querySelector('summary')?.focus({ preventScroll: true })
            }}
            className="flex w-full items-center gap-2 rounded px-3 py-2.5 text-left text-sm hover:bg-muted"
          >
            <MapPin size={16} /> Show all locations
          </button>
        </div>
      </details>
      <MapContainer
        key={`${username}:${scope}:${year}`}
        preferCanvas
        center={[20, 0]}
        zoom={2}
        maxZoom={TRAVEL_MAX_ZOOM}
        zoomAnimation={false}
        fadeAnimation={false}
        className="travel-map absolute inset-0 h-full w-full"
        // View fits the overview and preserves manual views on resize. A second
        // maxBounds pan can run after that fit and move locations off-screen.
        scrollWheelZoom={false}
        touchZoom={true}
        zoomSnap={0}
      >
        <MapGestures />
        <BasemapLayer maxZoom={TRAVEL_MAX_ZOOM} />
        <View places={places} selected={selected} mapSelectionRef={mapSelection} reset={reset} />
        <Dots
          scope={scope}
          year={year}
          onSelect={(id) => {
            if (id !== selected) mapSelection.current = true
            onSelect(id)
          }}
        />
      </MapContainer>
    </dialog>
  )
}
