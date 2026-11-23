// Browser-only storage with mandatory validation. No fresh/offline reuse or edge caching.
export const THUMBNAIL_CACHE_CONTROL = 'private, no-cache, max-age=0, must-revalidate, no-transform'
export function isThumbnailRequest(request, path) {
  const url = new URL(request.url)
  return (
    request.method === 'GET' &&
    url.pathname === '/api/images' &&
    url.searchParams.get('download') !== '1' &&
    !request.headers.has('range') &&
    typeof path === 'string' &&
    path.startsWith('thumbnails/')
  )
}
export function thumbnailValidator(request) {
  const tag = request.headers.get('if-none-match')
  return tag && tag.length <= 2048 ? tag : null
}
export function hasRevalidatedThumbnailPolicy(request, response) {
  return (
    isThumbnailRequest(request, new URL(request.url).searchParams.get('path')) &&
    [200, 304].includes(response.status) &&
    response.headers.get('cache-control') === THUMBNAIL_CACHE_CONTROL
  )
}
