/** Holds actual image elements so no-store responses need not be downloaded twice.
 * Never used as permission authority: the viewer checks photo access before attaching one.
 * Four elements maximum (current, next two, previous); cleared on identity changes/logout.
 */
export class ViewerImageBuffer {
  scope = ''
  images = new Map()
  timer
  constructor(create = () => new Image()) {
    this.create = create
  }
  key(photo) {
    return `${photo.photoId}:${photo.url}`
  }
  select(scope, photos) {
    if (scope !== this.scope) this.clear()
    this.scope = scope
    clearTimeout(this.timer)
    const keys = new Set(photos.slice(0, 4).map((p) => this.key(p)))
    for (const [key, image] of this.images) {
      if (!keys.has(key)) {
        image.removeAttribute('src')
        image.remove()
        this.images.delete(key)
      }
    }
  }
  get(photo, priority) {
    const key = this.key(photo)
    let image = this.images.get(key)
    if (image?.complete && !image.naturalWidth) {
      image.removeAttribute('src')
      this.images.delete(key)
      image = undefined
    }
    if (!image) {
      if (this.images.size >= 4) return null
      image = this.create()
      image.decoding = 'async'
      image.fetchPriority = priority
      image.src = photo.url
      this.images.set(key, image)
    }
    image.fetchPriority = priority
    return image
  }
  dimensions(photo) {
    const image = this.images.get(this.key(photo))
    return image?.naturalWidth && image.naturalHeight
      ? { ...photo, width: image.naturalWidth, height: image.naturalHeight }
      : photo
  }
  release() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.clear(), 30_000)
  }
  clear() {
    clearTimeout(this.timer)
    for (const image of this.images.values()) {
      image.removeAttribute('src')
      image.remove()
    }
    this.images.clear()
    this.scope = ''
  }
}
export const viewerImages = new ViewerImageBuffer()
export function clearViewerImages() {
  viewerImages.clear()
}
/** Avoid holding several exceptionally large decoded images on phones. Never resize. */
export function preloadWindow(current, neighbors) {
  let pixels = (current.width ?? 4000) * (current.height ?? 3000)
  const seen = new Set([current.photoId])
  return neighbors.slice(0, 3).filter((photo) => {
    if (seen.has(photo.photoId)) return false
    seen.add(photo.photoId)
    const size = (photo.width ?? 4000) * (photo.height ?? 3000)
    if (size <= 0 || pixels + size > 48_000_000) return false
    pixels += size
    return true
  })
}
