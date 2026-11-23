/**
 * Exact public capability routes; batching is read-only despite using POST.
 * @param {string} path
 * @param {string} method
 */
export function publicShareRoute(path, method) {
  return (
    (method === 'GET' &&
      /^\/share\/[A-Za-z0-9_-]{43}(?:\/media\/[0-9]+|\/download)?$/.test(path)) ||
    (method === 'POST' && /^\/share\/[A-Za-z0-9_-]{43}\/previews$/.test(path))
  )
}
