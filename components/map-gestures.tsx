'use client'
import { useEffect } from 'react'
import { useMap } from 'react-leaflet'

/** Desktop pinch gestures; Leaflet continues to handle touchscreen pinch. */
export function MapGestures() {
  const map = useMap()
  useEffect(() => {
    const container = map.getContainer()
    let frame = 0
    let pendingZoom: number | null = null
    let anchor = map.getSize().divideBy(2)
    let gesture = false
    let startZoom = 0
    const schedule = (zoom: number, x: number, y: number) => {
      pendingZoom = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), zoom))
      const rect = container.getBoundingClientRect()
      anchor.x = Number.isFinite(x) ? x - rect.left : rect.width / 2
      anchor.y = Number.isFinite(y) ? y - rect.top : rect.height / 2
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0
          if (pendingZoom !== null) {
            map.setZoomAround(anchor, pendingZoom, { animate: false })
            pendingZoom = null
          }
        })
    }
    const wheel = (event: WheelEvent) => {
      // Browsers expose trackpad pinch as Ctrl+wheel. Ordinary scrolling stays native.
      if (!event.ctrlKey) return
      event.preventDefault()
      event.stopPropagation()
      if (gesture) return
      const pixels =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1)
      schedule((pendingZoom ?? map.getZoom()) - pixels / 100, event.clientX, event.clientY)
    }
    type Gesture = Event & { scale: number; clientX: number; clientY: number }
    const start = (event: Event) => {
      if (!window.matchMedia('(pointer:fine)').matches) return
      event.preventDefault()
      gesture = true
      startZoom = pendingZoom ?? map.getZoom()
    }
    const change = (event: Event) => {
      if (!gesture) return
      event.preventDefault()
      const e = event as Gesture
      if (Number.isFinite(e.scale) && e.scale > 0)
        schedule(startZoom + Math.log2(e.scale), e.clientX, e.clientY)
    }
    const end = (event: Event) => {
      if (gesture) event.preventDefault()
      gesture = false
    }
    container.addEventListener('wheel', wheel, { passive: false })
    container.addEventListener('gesturestart', start, { passive: false })
    container.addEventListener('gesturechange', change, { passive: false })
    container.addEventListener('gestureend', end, { passive: false })
    return () => {
      cancelAnimationFrame(frame)
      container.removeEventListener('wheel', wheel)
      container.removeEventListener('gesturestart', start)
      container.removeEventListener('gesturechange', change)
      container.removeEventListener('gestureend', end)
    }
  }, [map])
  return null
}
