import { expect, it, vi } from 'vitest'
import type { Map } from 'leaflet'
import { createTravelView } from '@/lib/travel/travel-map-view'

function setup() {
  let moved = () => {}
  const center = { lat: 10, lng: 20 }
  const map = {
    on: vi.fn((_events, fn) => {
      moved = fn
    }),
    off: vi.fn(),
    fitBounds: vi.fn(() => moved()),
    invalidateSize: vi.fn(() => moved()),
    setView: vi.fn(() => moved()),
    getCenter: () => center,
    getZoom: () => 11,
    getPixelWorldBounds: () => ({ min: { y: 0 }, max: { y: 2048 } }),
    project: () => ({ x: 500, y: 1000 }),
    unproject: vi.fn(([x, y]) => ({ lat: y, lng: x })),
    getSize: () => ({ x: 1000, y: 700 }),
  }
  const places = [
    { lat: -20, lng: -80 },
    { lat: 45, lng: 140 },
  ]
  return {
    map,
    center,
    moved: () => moved(),
    controller: createTravelView(map as unknown as Map, places),
  }
}
it('uses compact overview padding on mobile so locations use the available width', () => {
  const { map, controller } = setup()
  map.getSize = () => ({ x: 350, y: 350 })
  controller.showAll()
  expect(map.fitBounds).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ paddingTopLeft: [24, 60], paddingBottomRight: [24, 24] }),
  )
})
it('fits every location initially and refits the overview when fullscreen size changes', () => {
  const { map, controller } = setup()
  controller.showAll()
  controller.resize()
  expect(map.fitBounds).toHaveBeenCalledTimes(2)
  expect(map.fitBounds).toHaveBeenLastCalledWith(
    [
      [-20, -80],
      [45, 140],
    ],
    expect.objectContaining({ animate: false, paddingTopLeft: [35, 105] }),
  )
})
it('keeps manual pan/zoom through resize, and reset restores automatic fitting', () => {
  const { map, center, moved, controller } = setup()
  controller.showAll()
  moved()
  controller.resize()
  expect(map.fitBounds).toHaveBeenCalledTimes(1)
  expect(map.setView).toHaveBeenLastCalledWith(center, 11, { animate: false })
  controller.showAll()
  controller.resize()
  expect(map.fitBounds).toHaveBeenCalledTimes(3)
})
it('preserves a place chosen from the list and detaches listeners on cleanup', () => {
  const { map, controller } = setup()
  controller.focus({ lat: 1, lng: 2 })
  controller.resize()
  expect(map.fitBounds).not.toHaveBeenCalled()
  controller.dispose()
  expect(map.off).toHaveBeenCalledWith('movestart zoomstart', expect.any(Function))
})
it('refreshes overview bounds but does not reset a manually chosen view on data refresh', () => {
  const { map, moved, controller } = setup()
  controller.updatePlaces([{ lat: 1, lng: 2 }])
  expect(map.fitBounds).toHaveBeenCalledTimes(1)
  moved()
  controller.updatePlaces([{ lat: 3, lng: 4 }])
  expect(map.fitBounds).toHaveBeenCalledTimes(1)
  controller.showAll()
  expect(map.fitBounds).toHaveBeenLastCalledWith([[3, 4]], expect.any(Object))
})

it('keeps the mobile overview inside the available tile rows without changing its fitted zoom', () => {
  const { map, controller } = setup()
  map.getSize = () => ({ x: 360, y: 240 })
  map.getPixelWorldBounds = () => ({ min: { y: 0 }, max: { y: 320 } })
  map.project = () => ({ x: 160, y: 80 })
  controller.showAll()
  expect(map.unproject).toHaveBeenCalledWith([160, 120], 11)
  expect(map.setView).toHaveBeenLastCalledWith({ lat: 120, lng: 160 }, 11, { animate: false })
})
