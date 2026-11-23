import { readClientResponse } from '../client-response'

export interface AlbumDestinationPage {
  items: { eventId: number; eventName: string; canEdit: boolean }[]
  nextCursor: string | null
}

export type AlbumDestinationOrder = 'natural' | 'server'
export function mergeAlbumDestinations(
  previous: { eventId: number; eventName: string }[],
  incoming: AlbumDestinationPage['items'],
  order: AlbumDestinationOrder,
) {
  const albums = new Map(previous.map((album) => [album.eventId, album]))
  for (const album of incoming) {
    if (album.canEdit) albums.set(album.eventId, album)
    else albums.delete(album.eventId)
  }
  const values = [...albums.values()]
  return order === 'natural'
    ? values.sort((a, b) =>
        a.eventName
          .trim()
          .localeCompare(b.eventName.trim(), undefined, { sensitivity: 'base', numeric: true }),
      )
    : values
}

function isDestinationPage(value: unknown): value is AlbumDestinationPage {
  if (!value || typeof value !== 'object') return false
  const page = value as AlbumDestinationPage
  return (
    Array.isArray(page.items) &&
    page.items.every(
      (item) =>
        item &&
        Number.isSafeInteger(item.eventId) &&
        item.eventId > 0 &&
        typeof item.eventName === 'string' &&
        typeof item.canEdit === 'boolean',
    ) &&
    (page.nextCursor === null ||
      (typeof page.nextCursor === 'string' && page.nextCursor.length > 0))
  )
}

export async function loadAlbumDestinations(cursor: string | null, signal: AbortSignal) {
  const params = new URLSearchParams({ paged: 'true', groups: 'false' })
  if (cursor) params.set('cursor', cursor)
  signal = AbortSignal.any([signal, AbortSignal.timeout(45000)])
  const response = await fetch('/api/events?' + params, { signal })
  const page = await readClientResponse(
    response,
    'Unable to load destination albums. Try again.',
    isDestinationPage,
  )
  signal.throwIfAborted()
  return page
}
