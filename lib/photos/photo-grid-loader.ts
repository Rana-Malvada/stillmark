import { ClientResponseError, readClientResponse } from '../client-response'
import { fetchBrowse } from '../fetch-browse'

export interface GridPhoto {
  photoId: number
  sourceFilename: string
  thumbnailUrl: string | null
  aspectRatio: number | null
  mediaType: string
  favorite: boolean
  eventId: number
  eventName?: string
  caption?: string | null
  canEdit?: boolean
}
interface PhotoPage {
  items: GridPhoto[]
  nextCursor: string | null
}
interface PhotoSnapshot {
  items: GridPhoto[]
  cursor: string | null
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
function isPhotoPage(value: unknown): value is PhotoPage {
  return (
    record(value) &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) =>
        record(item) &&
        Number.isSafeInteger(item.photoId) &&
        Number(item.photoId) > 0 &&
        Number.isSafeInteger(item.eventId) &&
        Number(item.eventId) > 0 &&
        typeof item.sourceFilename === 'string' &&
        typeof item.mediaType === 'string' &&
        typeof item.favorite === 'boolean' &&
        (item.canEdit === undefined || typeof item.canEdit === 'boolean') &&
        (item.thumbnailUrl === null || typeof item.thumbnailUrl === 'string') &&
        (item.aspectRatio === null ||
          (typeof item.aspectRatio === 'number' && Number.isFinite(item.aspectRatio))) &&
        (item.eventName === undefined || typeof item.eventName === 'string') &&
        (item.caption === undefined || item.caption === null || typeof item.caption === 'string'),
    ) &&
    (value.nextCursor === null ||
      (typeof value.nextCursor === 'string' && value.nextCursor.length > 0))
  )
}

export function photoRestoreTarget(
  eventId: number | undefined,
  returning: boolean,
  remembered: unknown,
) {
  if (eventId && !returning) return 96
  const count = Number(remembered)
  return Number.isSafeInteger(count) && count > 96 ? count : 96
}

export async function loadPhotoPage(
  eventId: number | undefined,
  query: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<PhotoPage> {
  const params = new URLSearchParams(query)
  params.set('paged', 'true')
  if (cursor) params.set('cursor', cursor)
  const response = await fetchBrowse(
    `${eventId ? `/api/events/${eventId}` : '/api/favorites'}?${params}`,
    { signal },
  )
  const page = await readClientResponse(response, 'Unable to load photos. Try again.', isPhotoPage)
  signal?.throwIfAborted()
  if (eventId && page.items.some((photo) => photo.eventId !== eventId))
    throw new ClientResponseError('Unable to load photos. Try again.', response.status)
  return page
}

/** Always authorize with a live first page before displaying a return snapshot. */
export async function loadPhotoPages(options: {
  eventId?: number
  query: string
  target: number
  snapshot?: PhotoSnapshot | null
  signal: AbortSignal
  onPage?: (items: GridPhoto[]) => void
}): Promise<PhotoSnapshot & { reused: boolean }> {
  let cursor: string | null = null
  const all: GridPhoto[] = []
  const seenCursors = new Set<string>()
  const ids = new Set<number>()
  let published = 0
  do {
    const page = await loadPhotoPage(options.eventId, options.query, cursor, options.signal)
    const first = all.length === 0
    const added = page.items.filter((photo) => {
      if (ids.has(photo.photoId)) return false
      ids.add(photo.photoId)
      return true
    })
    all.push(...added)
    cursor = page.nextCursor
    const cached = options.snapshot
    if (
      first &&
      all.length > 0 &&
      cached &&
      (cursor || cached.items.length <= all.length) &&
      all.every((photo, index) => photo.photoId === cached.items[index]?.photoId)
    ) {
      const liveIds = new Set(all.map((photo) => photo.photoId))
      all.push(...cached.items.filter((photo) => !liveIds.has(photo.photoId)))
      return { items: all, cursor: cached.cursor, reused: true }
    }
    // Publish the first page promptly, then geometric checkpoints during a deep
    // restore. Immutable snapshots remain safe for React without quadratic copies.
    if (!published || all.length >= published * 2 || !cursor || all.length >= options.target) {
      options.onPage?.([...all])
      published = all.length
    }
    if (cursor && (seenCursors.has(cursor) || added.length === 0))
      throw new ClientResponseError('Unable to load photos. Try again.', 200)
    if (cursor) seenCursors.add(cursor)
  } while (cursor && all.length < options.target)
  return { items: all, cursor, reused: false }
}
