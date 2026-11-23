import type { Map } from 'leaflet'

type Location = { lat: number; lng: number }

// Overview follows the available space; a manually chosen view keeps its center
// and zoom through dialog/fullscreen and browser size changes.
export function createTravelView(map: Map, places: Location[]) {
  let overview = true
  let adjusting = false
  const moved = () => {
    if (!adjusting) overview = false
  }
  map.on('movestart zoomstart', moved)
  const adjust = (fn: () => void) => {
    adjusting = true
    try {
      fn()
    } finally {
      adjusting = false
    }
  }
  const keepOverviewInsideWorld = () => {
    const zoom = map.getZoom()
    const world = map.getPixelWorldBounds(zoom)
    if (!world?.min || !world.max) return
    const halfHeight = map.getSize().y / 2
    const center = map.project(map.getCenter(), zoom)
    // Tile rows stop at the Mercator poles. Center the viewport within those
    // rows instead of leaving blank bands when fitBounds favors northern trips.
    const minimum = world.min.y + halfHeight
    const maximum = world.max.y - halfHeight
    const y =
      minimum <= maximum
        ? Math.max(minimum, Math.min(maximum, center.y))
        : (world.min.y + world.max.y) / 2
    if (Math.abs(y - center.y) > 0.5)
      map.setView(map.unproject([center.x, y], zoom), zoom, { animate: false })
  }
  const fit = () => {
    const compact = map.getSize().x < 640
    if (places.length)
      map.fitBounds(
        places.map((p) => [p.lat, p.lng] as [number, number]),
        {
          paddingTopLeft: compact ? [24, 60] : [35, 105],
          paddingBottomRight: compact ? [24, 24] : [35, 35],
          maxZoom: places.length === 1 ? 9 : 14,
          animate: false,
        },
      )
    keepOverviewInsideWorld()
  }
  return {
    updatePlaces(next: Location[]) {
      places = next
      if (overview) adjust(fit)
    },
    showAll() {
      overview = true
      adjust(() => {
        map.invalidateSize({ animate: false })
        fit()
      })
    },
    focus(place: Location) {
      overview = false
      adjust(() =>
        map.setView([place.lat, place.lng], Math.max(8, map.getZoom()), { animate: false }),
      )
    },
    resize() {
      adjust(() => {
        const center = map.getCenter()
        const zoom = map.getZoom()
        map.invalidateSize({ animate: false })
        if (overview) fit()
        else map.setView(center, zoom, { animate: false })
      })
    },
    dispose() {
      map.off('movestart zoomstart', moved)
    },
  }
}
