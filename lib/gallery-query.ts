/** Shared gallery URL vocabulary. Server photoFilters validates values before SQL use. */
export const galleryQueryKeys = [
  'sort',
  'media',
  'favorite',
  'from',
  'to',
  'camera',
  'location',
] as const
export const photoSorts = {
  oldest: { key: 'COALESCE(date_taken,created_at)', descending: false },
  newest: { key: 'COALESCE(date_taken,created_at)', descending: true },
  name: { key: 'source_filename', descending: false },
  uploaded: { key: 'created_at', descending: true },
} as const
export function galleryQueryString(
  input: URLSearchParams | Record<string, string | string[] | undefined>,
) {
  const result = new URLSearchParams()
  for (const key of galleryQueryKeys) {
    const value = input instanceof URLSearchParams ? input.get(key) : input[key]
    if (typeof value === 'string' && value && !(key === 'sort' && value === 'oldest'))
      result.set(key, value)
  }
  return result.toString()
}
export function galleryViewerContext(query: string, favorites: boolean) {
  const params = new URLSearchParams(galleryQueryString(new URLSearchParams(query)))
  params.set('context', favorites ? 'favorites' : 'album')
  return params.toString()
}
/** Preserve explicit gallery origins without inventing one for People/search links. */
export function galleryPhotoContext(
  input: URLSearchParams | Record<string, string | string[] | undefined>,
) {
  const params = new URLSearchParams(galleryQueryString(input))
  const context = input instanceof URLSearchParams ? input.get('context') : input.context
  if (context === 'album' || context === 'favorites') params.set('context', context)
  return params.toString()
}
export function galleryReturnPath(
  eventId: number | undefined,
  context: string,
  rememberedParent = '',
) {
  const params = new URLSearchParams(context)
  const query = galleryQueryString(params)
  const origin = params.get('context')
  const validAlbum = Number.isSafeInteger(eventId) && Number(eventId) > 0
  const base = origin === 'favorites' ? '/favorites' : validAlbum ? `/events/${eventId}` : '/'
  const fallback = `${base}${base !== '/' && query ? `?${query}` : ''}`
  // Adjacent favorites can cross album boundaries. A stale per-album parent must
  // never override the explicit origin carried through the current viewer URL.
  if (origin === 'favorites' || origin === 'album') return fallback
  return rememberedParent || fallback
}
