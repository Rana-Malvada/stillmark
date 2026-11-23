import { verifyThumbnailGrant } from '../lib/media-grant.mjs'
import { THUMBNAIL_CACHE_CONTROL } from '../lib/thumbnail-cache.mjs'
import { deliverMedia } from './media-delivery.mjs'
// Cache is optional: a stalled cache must not hold a thumbnail response indefinitely.
/**
 * @template T
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
async function cacheBudget(work) {
  let timer
  let expired = false
  const pending = Promise.resolve()
    .then(work)
    // A cache read resolves to a response or nothing; a cache write to nothing.
    .then((/** @type {any} */ value) => {
      if (expired && value?.body) void value.body.cancel().catch(() => {})
      return value
    })
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true
          reject(Error('Thumbnail cache timeout'))
        }, 250)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
// All cache access happens AFTER capability + current gateway session validation.
/**
 * @param {Request} request
 * @param {Env} env
 * @param {Session | null} session
 * @param {Fetch} [fetcher]
 * @param {Cache | undefined} [cache]
 */
export async function grantedThumbnail(
  request,
  env,
  session,
  fetcher = fetch,
  cache = globalThis.caches?.default,
) {
  const url = new URL(request.url)
  if (
    env.CUSTOMER_ACCOUNTS_ENABLED === 'true' ||
    env.MEDIA_GRANTS_ENABLED !== 'true' ||
    env.MEDIA_DELIVERY_MODE !== 'enabled' ||
    !session ||
    request.method !== 'GET' ||
    url.pathname !== '/api/images' ||
    !url.searchParams.has('grant')
  )
    return null
  if (
    url.searchParams.get('download') === '1' ||
    request.headers.has('range') ||
    [...url.searchParams.keys()].some((k) => !['path', 'grant'].includes(k)) ||
    url.searchParams.getAll('path').length !== 1 ||
    url.searchParams.getAll('grant').length !== 1
  )
    return new Response('Forbidden', {
      status: 403,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  let grant
  try {
    grant = await verifyThumbnailGrant(
      url.searchParams.get('grant'),
      url.searchParams.get('path'),
      session,
      env.GATEWAY_ORIGIN,
      env.MEDIA_GRANT_SIGNING_KEY,
    )
  } catch {
    return new Response('Forbidden', {
      status: 403,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }
  if (!grant) return null // Expired URLs reauthorize through the app; never serve expired grants from cache.
  const cacheEnabled = env.MEDIA_GRANT_CACHE_ENABLED === 'true' && cache
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${env.SNOWFLAKE_ORIGIN}|${grant.path}|thumbnail`),
  )
  const key = new Request(
    env.GATEWAY_ORIGIN +
      '/__private_thumbnail_cache/' +
      Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''),
  )
  /** @param {Response} response */
  const outgoing = (response) => {
    const h = new Headers(response.headers)
    h.set('Cache-Control', THUMBNAIL_CACHE_CONTROL)
    h.delete('set-cookie')
    h.set('Referrer-Policy', 'no-referrer')
    h.set('X-Media-Authorization', 'grant')
    h.set('X-Media-Upstream-Attempts', '0')
    return new Response(response.body, { status: response.status, headers: h })
  }
  if (cacheEnabled) {
    try {
      const cacheStarted = performance.now()
      const hit = await cacheBudget(() => cache.match(key))
      if (hit) {
        const h = new Headers(hit.headers)
        h.set('X-Media-Cache', 'hit')
        h.set('X-Media-Delivery', 'edge-cache')
        h.set('Server-Timing', `media_cache;dur=${(performance.now() - cacheStarted).toFixed(1)}`)
        if (h.get('etag') && request.headers.get('if-none-match') === h.get('etag')) {
          void hit.body?.cancel().catch(() => {})
          h.delete('content-length')
          return outgoing(new Response(null, { status: 304, headers: h }))
        }
        return outgoing(new Response(hit.body, { headers: h }))
      }
    } catch {
      /* Cache availability never determines authorization. */
    }
  }
  // Existing fixed-host signing/fetch implementation and bounded header deadlines.
  const media = await deliverMedia(
    request,
    Response.json({ path: grant.path, type: 'image/jpeg', revalidateThumbnail: true }),
    env,
    fetcher,
  )
  media.headers.set('X-Media-Cache', cacheEnabled ? 'miss' : 'disabled')
  // Only cache immutable, bounded complete thumbnails. No ranges, errors or credentials.
  const size = Number(media.headers.get('content-length'))
  if (cacheEnabled && media.status === 200 && size > 0 && size <= 512 * 1024) {
    const clone = media.clone()
    const h = new Headers(media.headers)
    h.set('Cache-Control', 'public, max-age=3600, immutable')
    h.delete('set-cookie')
    try {
      await cacheBudget(() => cache.put(key, new Response(clone.body, { headers: h })))
    } catch {
      void clone.body?.cancel().catch(() => {})
    }
  }
  return outgoing(media)
}
