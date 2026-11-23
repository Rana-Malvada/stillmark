export interface ViewerImage {
  photoId: number
  url: string
  width?: number | null
  height?: number | null
}
export class ViewerImageBuffer {
  constructor(create?: () => HTMLImageElement)
  select(scope: string, photos: ViewerImage[]): void
  get(photo: ViewerImage, priority: 'high' | 'low'): HTMLImageElement | null
  dimensions(photo: ViewerImage): ViewerImage
  release(): void
  clear(): void
}
export const viewerImages: ViewerImageBuffer
export function clearViewerImages(): void
export function preloadWindow(current: ViewerImage, neighbors: ViewerImage[]): ViewerImage[]
