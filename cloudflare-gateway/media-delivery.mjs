import { facePreviewPath } from '../public/preview-batch.mjs'
import {
  isThumbnailRequest,
  THUMBNAIL_CACHE_CONTROL,
  thumbnailValidator,
} from '../lib/thumbnail-cache.mjs'
import { deployment, objects } from '../config/deployment.mjs'
// These URLs are signed through the PUBLIC SQL API, not the SPCS runtime.
// Cache storage credentials only. Every request must still pass the live app ACL.
const SQL = deployment.SNOWFLAKE_API_ORIGIN + '/api/v2/statements'
const HOST = deployment.STORAGE_HOST
/** @typedef {{ url: string, expires: number }} SignedLink */
/** @type {Map<string, SignedLink>} */
const links = new Map()
// Keep the existing 15-minute signatures; expire locally 30 seconds early.
const LINK_CACHE_MS = (900 - 30) * 1000
/**
 * @param {unknown} path
 * @returns {path is string}
 */
export function validMediaPath(path) {
  return (
    typeof path === 'string' &&
    path.length <= 1024 &&
    /^(originals|display|thumbnails)\//.test(path) &&
    !path.includes('\\') &&
    !path.split('/').some((x) => !x || x === '.' || x === '..')
  )
}
export function clearMediaLinks() {
  links.clear()
}
/**
 * @param {string[]} paths
 * @param {Env} env
 * @param {Fetch} fetcher
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>}
 */
function signPaths(paths, env, fetcher, signal) {
  return (async () => {
    const headers = {
      'User-Agent': 'PersonalPhotosMediaDelivery/1.0',
      Authorization: `Bearer ${env.SNOWFLAKE_PAT}`,
      'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    const body = {
      // A UNION query requires a warehouse even though each scalar signing
      // function does not. Keep all URLs in one projection, with no FROM.
      statement:
        'SELECT ' +
        paths
          .map(
            (path, index) =>
              `GET_PRESIGNED_URL(${path.startsWith('display/prepared/') || facePreviewPath(path) ? '@' + objects.derived : '@' + objects.originals}, '${path.replaceAll("'", "''")}', 900) AS URL_${index}`,
          )
          .join(', '),
      timeout: 10,
      role: deployment.GATEWAY_ROLE,
      parameters: { query_tag: 'personal-photos-media-delivery' },
    }
    let r = await fetcher(SQL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    })
    for (let i = 0; r.status === 202 && i < 5; i++) {
      const job = await r.json()
      if (!/^[a-f0-9-]{36}$/i.test(job.statementHandle ?? ''))
        throw Error('Media signing response invalid')
      await new Promise((resolve) => setTimeout(resolve, 250))
      r = await fetcher(SQL + '/' + job.statementHandle, {
        headers,
        redirect: 'manual',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
      })
    }
    if (!r.ok || r.status === 202) {
      const error = await r.json().catch(() => null)
      console.warn(
        'media_signing_failed',
        r.status,
        /^[0-9]+$/.test(error?.code ?? '') ? error.code : 'unknown',
      )
      throw Error('Media signing unavailable')
    }
    const data = await r.json()
    const rows = data.data
    if (
      !Array.isArray(rows) ||
      rows.length !== 1 ||
      !Array.isArray(rows[0]) ||
      rows[0].length !== paths.length ||
      !rows[0].every((value) => typeof value === 'string')
    )
      throw Error('Media signing response invalid')
    return rows[0]
  })()
}
/**
 * @param {string} path
 * @param {Env} env
 * @param {Fetch} [fetcher]
 * @param {AbortSignal} [signal]
 */
export async function publicStorageUrl(path, env, fetcher = fetch, signal) {
  if (!validMediaPath(path)) throw Error('Invalid media path')
  // Absent on a cold path; the optional chain below then compares false.
  const cached = /** @type {SignedLink} */ (links.get(path))
  if (cached?.expires > Date.now()) {
    // Refresh LRU position, never the signature expiry or authorization lifetime.
    links.delete(path)
    links.set(path, cached)
    return cached.url
  }
  links.delete(path)
  // Cloudflare ties asynchronous work to its originating HTTP request. Sharing
  // unresolved promises or batch timers can strand the other requests forever.
  // Cache only completed strings; cold requests sign independently in parallel.
  const started = Date.now()
  const value = (await signPaths([path], env, fetcher, signal))[0]
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== HOST ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw Error('Media signing destination invalid')
  const configured = Number(env.MEDIA_SIGNED_URL_CACHE_MAX ?? 5000)
  const capacity =
    Number.isSafeInteger(configured) && configured >= 1 && configured <= 10000 ? configured : 5000
  while (links.size >= capacity) links.delete(/** @type {string} */ (links.keys().next().value))
  links.set(path, { url: url.toString(), expires: started + LINK_CACHE_MS })
  return url.toString()
}

/**
 * One request owns every cold miss; no cross-request promises or timers.
 * @param {string[]} paths
 * @param {Env} env
 * @param {Fetch} [fetcher]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Map<string, string>>}
 */
export async function publicStorageUrls(paths, env, fetcher = fetch, signal) {
  if (
    !Array.isArray(paths) ||
    paths.length > 8 ||
    !paths.every((path) => validMediaPath(path) || facePreviewPath(path))
  )
    throw Error('Invalid media batch')
  const unique = [...new Set(paths)]
  const result = new Map()
  const missing = []
  for (const path of unique) {
    // Absent on a cold path; the optional chain below then compares false.
    const cached = /** @type {SignedLink} */ (links.get(path))
    if (cached?.expires > Date.now()) {
      links.delete(path)
      links.set(path, cached)
      result.set(path, cached.url)
    } else {
      links.delete(path)
      missing.push(path)
    }
  }
  if (missing.length) {
    const started = Date.now()
    const urls = await signPaths(missing, env, fetcher, signal)
    // Validate the entire result before caching any part.
    for (const value of urls) {
      const url = new URL(value)
      if (
        url.protocol !== 'https:' ||
        url.hostname !== HOST ||
        url.port ||
        url.username ||
        url.password ||
        url.hash
      )
        throw Error('Media signing destination invalid')
    }
    const configured = Number(env.MEDIA_SIGNED_URL_CACHE_MAX ?? 5000)
    const capacity =
      Number.isSafeInteger(configured) && configured >= 1 && configured <= 10000 ? configured : 5000
    missing.forEach((path, i) => {
      links.delete(path)
      while (links.size >= capacity) links.delete(/** @type {string} */ (links.keys().next().value))
      links.set(path, { url: urls[i], expires: started + LINK_CACHE_MS })
      result.set(path, urls[i])
    })
  }
  return result
}

/**
 * @param {Request} request
 * @param {Response} grant
 * @param {Env} env
 * @param {Fetch} [fetcher]
 */
export async function deliverMedia(request, grant, env, fetcher = fetch) {
  const data = await grant.json()
  if (
    !validMediaPath(data.path) ||
    typeof data.type !== 'string' ||
    !(/^(image|video)\/[a-z0-9.+-]+$/.test(data.type) || data.type === 'application/octet-stream')
  )
    throw Error('Media grant invalid')
  const cacheThumbnail = data.revalidateThumbnail === true && isThumbnailRequest(request, data.path)
  const validator = cacheThumbnail ? thumbnailValidator(request) : null
  const range = request.headers.get('range')
  if (range && (!/^bytes=(\d+-\d*|-\d+)$/.test(range) || range.length > 80))
    throw Error('Media range invalid')
  // Reserve time for the authorized app fallback inside the client's deadline.
  // This is a single signing + storage-header budget, not a per-attempt timeout.
  const budget = Number(env.MEDIA_EDGE_TIMEOUT_MS ?? 5000)
  if (!Number.isInteger(budget) || budget < 100 || budget > 10000)
    throw Error('Media edge timeout invalid')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), budget)
  const signal = AbortSignal.any([request.signal, controller.signal])
  let response
  let signingMs
  let storageMs
  try {
    const signingStarted = performance.now()
    const url = await publicStorageUrl(data.path, env, fetcher, signal)
    signingMs = performance.now() - signingStarted
    signal.throwIfAborted()
    const headers = new Headers({ 'Accept-Encoding': 'identity' })
    for (const name of ['range', 'if-range'])
      if (request.headers.has(name))
        headers.set(name, /** @type {string} */ (request.headers.get(name)))
    if (validator) headers.set('If-None-Match', validator)
    const storageStarted = performance.now()
    response = await fetcher(url, { headers, redirect: 'manual', signal })
    storageMs = performance.now() - storageStarted
  } finally {
    // Do not apply the header deadline to a healthy video/body stream.
    clearTimeout(timer)
  }
  if (![200, 206, 416].includes(response.status) && !(validator && response.status === 304)) {
    links.delete(data.path)
    await response.body?.cancel()
    throw Error('Media storage unavailable')
  }
  const outgoing = new Headers({
    'Server-Timing': `media_sign;dur=${signingMs.toFixed(1)}, media_storage;dur=${storageMs.toFixed(1)}`,
    'X-Media-Delivery': 'storage',
    'Content-Type': data.type,
    'Cache-Control':
      cacheThumbnail && [200, 304].includes(response.status)
        ? THUMBNAIL_CACHE_CONTROL
        : 'private, no-store, no-transform',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  })
  for (const name of [
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
  ]) {
    const v = response.headers.get(name)
    if (v && !(response.status === 304 && ['content-length', 'content-range'].includes(name)))
      outgoing.set(name, v)
  }
  return new Response(response.status === 304 ? null : response.body, {
    status: response.status,
    headers: outgoing,
  })
}
