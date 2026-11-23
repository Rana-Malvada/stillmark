// Only fixed categories and numeric measurements leave this module. Never emit URLs or headers.
/** @param {Request} request */
export function routeCategory(request) {
  const u = new URL(request.url)
  const p = u.pathname
  if (p.startsWith('/auth/')) return 'auth'
  if (p.startsWith('/share/'))
    return p.includes('/media/')
      ? u.searchParams.get('kind') === 'playlist'
        ? 'shared_playlist'
        : 'shared_media'
      : 'shared_album'
  if (p === '/api/images')
    return (u.searchParams.get('path') ?? '').startsWith('thumbnails/') ? 'thumbnail' : 'media'
  if (p.includes('/playback') || p.includes('/playlist')) return 'playlist'
  if (p.startsWith('/api/upload')) return 'upload'
  if (p.startsWith('/api/search')) return 'search'
  if (p.startsWith('/api/events')) return 'albums'
  if (p.startsWith('/api/photos')) return 'photos'
  if (p.startsWith('/_next/') || p === '/icon.svg') return 'static'
  return p.startsWith('/api/') ? 'other_api' : 'page'
}
// Per-isolate emergency ceiling, not an account-wide spending cap. No DB/DO calls.
/** @param {{ random?: () => number, now?: () => number, log?: (line: string) => void }} [options] */
export function createDiagnostics({
  random = Math.random,
  now = Date.now,
  log = console.warn,
} = {}) {
  let minute = -1
  let writes = 0
  let slowWrites = 0
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {Response | undefined} response
   * @param {number} elapsed
   */
  return function record(request, env, response, elapsed) {
    try {
      if (env.GATEWAY_DIAGNOSTICS !== 'enabled') return
      const rate = 0.01
      const bucket = Math.floor(now() / 60000)
      if (bucket !== minute) {
        minute = bucket
        writes = 0
        slowWrites = 0
      }
      const status = response?.status ?? 500
      const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(
        request.method,
      )
        ? request.method
        : 'OTHER'
      const timing = response?.headers.get('server-timing') ?? ''
      const auth = Number(/(?:^|,)\s*media_auth;dur=([\d.]+)/.exec(timing)?.[1])
      if (elapsed >= 2000 && slowWrites < 20) {
        slowWrites++
        /** @type {Record<string, number>} */
        const phases = {}
        for (const name of ['media_auth', 'media_sign', 'media_storage']) {
          const match = new RegExp('(?:^|,)\\s*' + name + ';dur=([\\d.]+)').exec(timing)
          if (match && Number.isFinite(Number(match[1])))
            phases[name] = Math.min(3600000, Number(match[1]))
        }
        log(
          JSON.stringify({
            event: 'slow_gateway',
            route: routeCategory(request),
            status,
            elapsedMs: Math.min(3600000, Math.max(0, Math.round(elapsed))),
            ...phases,
          }),
        )
      }
      if (!env.GATEWAY_METRICS || random() >= rate || writes >= 60) return
      writes++
      env.GATEWAY_METRICS.writeDataPoint({
        indexes: ['gateway-v1'],
        blobs: ['v1', routeCategory(request), method],
        // status, time to response headers (NOT whole-body download), sample rate, auth time, range request
        doubles: [
          status,
          Math.min(3600000, Math.max(0, Math.round(elapsed) || 0)),
          rate,
          Number.isFinite(auth) ? Math.min(3600000, auth) : -1,
          request.headers.has('range') ? 1 : 0,
        ],
      })
    } catch {
      /* Diagnostics must never break or delay delivery. */
    }
  }
}
export const recordDiagnostics = createDiagnostics()
