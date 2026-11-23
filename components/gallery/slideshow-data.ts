import { fetchBrowse } from '@/lib/fetch-browse'
import { readClientResponse } from '@/lib/client-response'

export interface SlideshowMedia {
  photoId: number
  sourceFilename: string
  mediaType: 'photo' | 'video'
  displayStagePath: string | null
  originalStagePath: string | null
}
export interface SlideshowPage {
  items: SlideshowMedia[]
  nextCursor: string | null
}
export function isSlideshowPage(value: unknown): value is SlideshowPage {
  if (!value || typeof value !== 'object') return false
  const page = value as Record<string, unknown>
  return (
    Array.isArray(page.items) &&
    page.items.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        Number.isSafeInteger(item.photoId) &&
        item.photoId > 0 &&
        typeof item.sourceFilename === 'string' &&
        ['photo', 'video'].includes(item.mediaType) &&
        [item.displayStagePath, item.originalStagePath].every(
          (path) => path === null || typeof path === 'string',
        ),
    ) &&
    (page.nextCursor === null ||
      (typeof page.nextCursor === 'string' && page.nextCursor.length > 0))
  )
}
/** Both initial and continuation reads obey the same contract and cancellation fence. */
export async function loadSlideshowPage(
  eventId: number,
  query: string,
  signal: AbortSignal,
  cursor?: string,
) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(45000)])
  const params = new URLSearchParams(query)
  params.set('paged', 'true')
  if (cursor) params.set('cursor', cursor)
  const data = await readClientResponse(
    await fetchBrowse(`/api/events/${eventId}?${params}`, { signal: bounded }),
    'Unable to load slideshow photos',
    isSlideshowPage,
  )
  bounded.throwIfAborted()
  return data
}
