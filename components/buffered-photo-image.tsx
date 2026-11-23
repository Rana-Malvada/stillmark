'use client'
import { useEffect, useRef, useState } from 'react'
import {
  type FaceBox,
  imageContentRect,
  type ImageRect,
  projectFaceBox,
} from '@/lib/people/face-highlight'
import { preloadWindow, type ViewerImage, viewerImages } from '@/lib/viewer-image-buffer'

export function BufferedPhotoImage({
  photo,
  neighbors,
  scope,
  fullScreen,
  alt,
  highlights = [],
  onIgnoredFaceClick,
}: {
  photo: ViewerImage
  neighbors: ViewerImage[]
  scope: string
  fullScreen: boolean
  alt: string
  highlights?: {
    faceId: number
    box: FaceBox
    label: string
    selected: boolean
    ignored?: boolean
  }[]
  onIgnoredFaceClick?: (faceId: number) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState<{ photoId: number; url: string; rect: ImageRect } | null>(
    null,
  )
  const neighborKey = JSON.stringify(neighbors)
  useEffect(() => {
    const next: ViewerImage[] = JSON.parse(neighborKey).slice(0, 3)
    viewerImages.select(scope, [photo, ...next])
    const image = viewerImages.get(photo, 'high')
    if (!image) return
    image.alt = alt
    image.draggable = false
    image.className = fullScreen
      ? 'w-full h-full object-contain select-none'
      : 'max-h-full max-w-full object-contain select-none'
    host.current?.replaceChildren(image)
    const measure = () => {
      const parent = host.current
      if (!parent || !image.complete || !image.naturalWidth) {
        setBounds(null)
        return
      }
      const hostRect = parent.getBoundingClientRect()
      const imgRect = image.getBoundingClientRect()
      const rect = imageContentRect(
        {
          left: imgRect.left - hostRect.left,
          top: imgRect.top - hostRect.top,
          width: imgRect.width,
          height: imgRect.height,
        },
        image.naturalWidth,
        image.naturalHeight,
      )
      setBounds(rect ? { photoId: photo.photoId, url: photo.url, rect } : null)
    }
    const observer = new ResizeObserver(measure)
    if (host.current) observer.observe(host.current)
    observer.observe(image)
    image.addEventListener('load', measure)
    image.addEventListener('error', measure)
    measure()
    let stopped = false
    let started = false
    let pendingIndex = 0
    let loadingIndex: number | null = null
    const cleanup: (() => void)[] = []
    const preloadAt = (index: number) => {
      pendingIndex = index
      if (
        stopped ||
        document.hidden ||
        index >= next.length ||
        (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
      )
        return
      const allowed = preloadWindow(
        viewerImages.dimensions(photo),
        next.map((p) => viewerImages.dimensions(p)),
      )
      if (loadingIndex === index) return
      const candidate = next[index]
      if (!allowed.some((p) => p.photoId === candidate.photoId)) {
        preloadAt(index + 1)
        return
      }
      const neighbor = viewerImages.get(candidate, 'low')
      if (!neighbor) return
      if (neighbor.complete && neighbor.naturalWidth) {
        preloadAt(index + 1)
        return
      }
      loadingIndex = index
      const done = () => {
        loadingIndex = null
        neighbor.removeEventListener('load', done)
        neighbor.removeEventListener('error', done)
        preloadAt(index + 1)
      }
      neighbor.addEventListener('load', done)
      neighbor.addEventListener('error', done)
      cleanup.push(() => {
        neighbor.removeEventListener('load', done)
        neighbor.removeEventListener('error', done)
      })
    }
    const preload = () => {
      if (started) return
      started = true
      preloadAt(0)
    }
    const resume = () => {
      if (!document.hidden && image.complete && image.naturalWidth) {
        if (started) preloadAt(pendingIndex)
        else preload()
      }
    }
    document.addEventListener('visibilitychange', resume)
    image.addEventListener('load', preload)
    if (image.complete && image.naturalWidth) preload()
    return () => {
      stopped = true
      observer.disconnect()
      image.removeEventListener('load', measure)
      image.removeEventListener('error', measure)
      document.removeEventListener('visibilitychange', resume)
      for (const remove of cleanup) remove()
      image.removeEventListener('load', preload)
      image.remove()
      viewerImages.release()
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- photo is a new object on every render; depending on it would tear down and reattach the buffered image each time, so only its identity and dimensions are tracked
  }, [photo.photoId, photo.url, scope, neighborKey, alt, photo.width, photo.height, fullScreen])
  const overlays =
    bounds?.photoId === photo.photoId && bounds.url === photo.url
      ? highlights.flatMap((face) => {
          const box = projectFaceBox(bounds.rect, face.box)
          return box ? [{ ...face, box }] : []
        })
      : []
  return (
    <div className="relative h-full w-full min-h-0">
      <div ref={host} className="h-full w-full min-h-0 flex items-center justify-center" />
      {overlays.map(({ faceId, box, label, selected, ignored }) => (
        <div
          key={faceId}
          role={ignored && onIgnoredFaceClick ? undefined : 'img'}
          aria-label={`Highlighted face: ${label}${selected ? ', selected' : ''}`}
          className={`absolute pointer-events-none rounded-sm shadow-[0_0_0_1px_var(--scrim),inset_0_0_0_1px_var(--scrim)] ${ignored ? 'border-2 border-dashed border-primary' : selected ? 'z-[1] border-[3px] border-primary' : 'border border-primary'}`}
          style={box}
        >
          {ignored && onIgnoredFaceClick && (
            <button
              type="button"
              aria-label={`Edit ignored face: ${label}`}
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full min-w-11 min-h-11 pointer-events-auto cursor-pointer focus-visible:outline-2 focus-visible:outline-primary"
              onTouchStart={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onIgnoredFaceClick(faceId)
              }}
            />
          )}
          <span
            aria-hidden="true"
            className="absolute left-1/2 h-3 w-3 -translate-x-1/2 rounded-full border-2 border-primary-foreground shadow-[0_0_0_1px_var(--scrim)] bg-primary"
            style={{ top: Math.max(-18, 2 - box.top) }}
          />
          <span
            className="absolute left-0 max-w-[min(14rem,70vw)] rounded bg-scrim/85 px-1.5 py-0.5 text-xs font-medium text-on-image whitespace-nowrap truncate"
            style={
              bounds && box.top + box.height + 28 > bounds.rect.top + bounds.rect.height
                ? { bottom: '100%', marginBottom: 20 }
                : { top: '100%', marginTop: 6 }
            }
          >
            {label}
          </span>
        </div>
      ))}
    </div>
  )
}
