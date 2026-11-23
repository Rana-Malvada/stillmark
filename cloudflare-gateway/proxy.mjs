import { publicShareRoute } from './public-share-route.mjs'
import { deliverPreviewBatch } from './preview-batch.mjs'
import { grantedThumbnail } from './thumbnail-grants.mjs'
import { isUploadServiceRoute } from '../lib/upload-service-policy.mjs'
import { hasRevalidatedThumbnailPolicy } from '../lib/thumbnail-cache.mjs'
import { deliverMedia } from './media-delivery.mjs'
import { alignMapReportPolicy } from './map-report-policy.mjs'
import { createUploadAdmission } from './upload-admission.mjs'
import { traceTransport } from './transport-trace.mjs'
import { headerBudget } from './header-budget.mjs'
/** @param {Uint8Array} value */
const encode = (value) =>
  btoa(String.fromCharCode(...value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
/**
 * @param {Session} session
 * @param {Env} env
 * @param {Request} request
 */
export async function identityAssertion(session, env, request) {
  if (!/^[a-f0-9]{64}$/.test(env.GATEWAY_SIGNING_KEY ?? ''))
    throw Error('Invalid signing configuration')
  const now = Math.floor(Date.now() / 1000)
  const body = encode(
    new TextEncoder().encode(
      JSON.stringify({
        jti: crypto.randomUUID(),
        method: request.method,
        target: new URL(request.url).pathname + new URL(request.url).search,
        sub: session.auth0Subject,
        startedAt: session.startedAt ?? session.iat,
        ...(new URL(request.url).pathname === '/api/account/bootstrap' && session.onboarding
          ? { onboarding: session.onboarding }
          : {}),
        ...(new URL(request.url).pathname === '/api/account/credential-change' &&
        session.credentialChange
          ? { credentialChange: session.credentialChange }
          : {}),
        sid: session.sid,
        iat: now,
        exp: now + 30,
        aud: env.GATEWAY_ORIGIN,
      }),
    ),
  )
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(
      // Checked above to be 64 hex characters, so it is set and always matches.
      /** @type {string[]} */ (/** @type {string} */ (env.GATEWAY_SIGNING_KEY).match(/../g)),
      (x) => parseInt(x, 16),
    ),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return (
    body +
    '.' +
    encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))))
  )
}
// Bound memory across concurrent requests in one Worker isolate. Only one 8 MiB
// upload chunk is buffered, never an entire video. Keep the identity TTL at 30s.
const MAX_UPLOAD_BODY = 8 * 1024 * 1024 + 64 * 1024
const uploadAdmission = createUploadAdmission({ maxBytes: 4 * MAX_UPLOAD_BODY })
/**
 * @param {Request} request
 * @param {Env} env
 * @param {Session | null} session Null only for public share routes.
 * @param {Fetch} [fetcher]
 * @returns {Promise<Response>}
 */
export async function proxyGallery(request, env, session, fetcher = fetch) {
  fetcher = traceTransport(request, env, fetcher)
  try {
    const thumbnail = await grantedThumbnail(request, env, session, fetcher)
    if (thumbnail) return thumbnail
  } catch (error) {
    if (request.signal.aborted) throw error
    // A storage/cache failure returns to the existing live app authorization path.
    console.warn('thumbnail_grant_delivery_fallback')
  }
  const upload = request.method === 'POST' && new URL(request.url).pathname === '/api/upload/chunk'
  const declared = Number(request.headers.get('content-length'))
  if (upload && declared > MAX_UPLOAD_BODY)
    return new Response('Upload chunk is too large', { status: 413 })
  // Unknown lengths reserve the full chunk limit. Known lengths allocate only
  // that space; a body exceeding its declaration is rejected, never expanded.
  const capacity = Number.isSafeInteger(declared) && declared > 0 ? declared : MAX_UPLOAD_BODY
  let release = null
  try {
    release = upload ? await uploadAdmission(capacity, request.signal) : null
    if (upload && !release)
      return new Response('Upload gateway is busy; retry this chunk.', {
        status: 429,
        headers: { 'Retry-After': '2', 'Cache-Control': 'no-store' },
      })
    return await proxyGalleryRequest(request, env, session, fetcher, upload, capacity)
  } catch (error) {
    if (upload && request.signal.aborted && !request.body?.locked)
      await request.body?.cancel().catch(() => {})
    throw error
  } finally {
    release?.()
  }
}
/**
 * @param {Request} request
 * @param {number} capacity
 * @returns {Promise<Uint8Array<ArrayBuffer> | null>} Null when the body exceeds its reservation.
 */
async function uploadBody(request, capacity) {
  if (Number(request.headers.get('content-length')) > MAX_UPLOAD_BODY) return null
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const buffer = new Uint8Array(capacity)
  let size = 0
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  request.signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      request.signal.throwIfAborted()
      const { value, done } = await reader.read()
      request.signal.throwIfAborted()
      if (done) return buffer.subarray(0, size)
      if (size + value.byteLength > capacity) {
        await reader.cancel()
        return null
      }
      buffer.set(value, size)
      size += value.byteLength
    }
  } finally {
    request.signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}
/**
 * @param {Request} request
 * @param {Env} env
 * @param {Session | null} session
 * @param {Fetch} fetcher
 * @param {boolean} upload
 * @param {number} [capacity]
 * @returns {Promise<Response>}
 */
async function proxyGalleryRequest(
  request,
  env,
  session,
  fetcher,
  upload,
  capacity = MAX_UPLOAD_BODY,
) {
  const source = new URL(request.url)
  const poolUpload = session && isUploadServiceRoute(source.pathname, request.method)
  if (poolUpload && !env.UPLOAD_SERVICE_ORIGIN)
    return new Response('Upload service is unavailable.', { status: 503 })
  const origin = new URL(
    // An unset origin throws here, which every caller reports as unavailable.
    poolUpload ? env.UPLOAD_SERVICE_ORIGIN : /** @type {string} */ (env.SNOWFLAKE_ORIGIN),
  )
  if (!session && !publicShareRoute(source.pathname, request.method))
    return new Response('Not found', { status: 404 })
  if (source.pathname === '/api/health/monitor') return new Response('Not found', { status: 404 })
  if (
    origin.protocol !== 'https:' ||
    !origin.hostname.endsWith('.snowflakecomputing.app') ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw Error('Invalid upstream')
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method))
    return new Response('Method not allowed', { status: 405 })
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
    (request.headers.get('origin') !== env.GATEWAY_ORIGIN ||
      request.headers.get('sec-fetch-site') === 'cross-site')
  )
    return new Response('Forbidden', { status: 403 })
  // Receive the bounded browser chunk BEFORE minting the short-lived assertion.
  // Slow client transfers otherwise exhaust its lifetime at buffering ingress.
  const body = upload ? await uploadBody(request, capacity) : request.body
  if (body === null && upload) return new Response('Upload chunk is too large', { status: 413 })
  request.signal.throwIfAborted()
  // Fixed destination; preserve path without permitting protocol-relative URL overrides.
  const upstream = new URL(origin)
  upstream.pathname = source.pathname
  upstream.search = source.search
  const headers = new Headers(request.headers)
  // oxlint-disable-next-line unicorn/no-useless-spread -- iterate a copy; the loop deletes headers
  for (const name of [...headers.keys()])
    if (
      /^(?:authorization|host|cookie|forwarded|x-forwarded-.*|sf-.*|x-photo-.*|cf-access-.*)$/i.test(
        name,
      )
    )
      headers.delete(name)
  const activity = request.headers
    .get('cookie')
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => /^gallery_activity=[A-Za-z0-9_-]{1,200}$/.test(x))
  if (activity) headers.set('cookie', activity)
  headers.set('authorization', `Snowflake Token="${env.SNOWFLAKE_PAT}"`)
  if (session)
    headers.set('x-photo-gateway-identity', await identityAssertion(session, env, request))
  const mediaRoute =
    (!!session &&
      source.pathname === '/api/images' &&
      source.searchParams.get('download') !== '1') ||
    (!session &&
      /^\/share\/[A-Za-z0-9_-]{43}\/media\/[0-9]+$/.test(source.pathname) &&
      source.searchParams.get('kind') !== 'original')
  const edge =
    mediaRoute &&
    request.method === 'GET' &&
    (env.MEDIA_DELIVERY_MODE === 'enabled' ||
      (env.MEDIA_DELIVERY_MODE === 'canary' && source.searchParams.get('transfer') === 'edge-test'))
  const previewBatch =
    !!session &&
    request.method === 'POST' &&
    ['/api/images/batch', '/api/faces/batch', '/api/trash/batch'].includes(source.pathname) &&
    env.PREVIEW_BATCH_ENABLED === 'true' &&
    env.MEDIA_DELIVERY_MODE === 'enabled'
  if (edge) headers.set('x-photo-media-transfer', 'public-sql-v2')
  if (previewBatch) headers.set('x-photo-media-transfer', 'preview-batch-v1')
  // Do not expose the private origin as a Referer or forward third-party credentials.
  headers.delete('referer')
  // Thumbnail bursts can receive transient ingress 504s. Retry only these
  // read-only requests, never writes, downloads, or video streams.
  const retryThumbnail =
    request.method === 'GET' &&
    source.pathname === '/api/images' &&
    (source.searchParams.get('path') ?? '').startsWith('thumbnails/') &&
    !headers.has('range')
  const authorizationStarted = performance.now()
  const correlationId = crypto.randomUUID()
  const mediaFetch = edge || retryThumbnail ? headerBudget(fetcher, request.signal) : fetcher
  headers.set('x-photo-request-id', correlationId)
  let response
  let attempts = 0
  for (let attempt = 0; ; attempt++) {
    attempts++
    if (attempt) {
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
      // A timed-out attempt may outlive the short-lived identity assertion.
      // Only /api/images is retried, and that path was refused above without a session.
      headers.set(
        'x-photo-gateway-identity',
        await identityAssertion(/** @type {Session} */ (session), env, request),
      )
    }
    try {
      response = await mediaFetch(upstream.toString(), {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : body,
        signal: request.signal,
        redirect: 'manual',
      })
    } catch (error) {
      if (edge || retryThumbnail)
        console.warn('media_upstream_attempt_failed', {
          id: correlationId,
          attempt: attempt + 1,
          phase: 'headers',
          status: 0,
          elapsedMs: Math.round(performance.now() - authorizationStarted),
        })
      if (!retryThumbnail || attempt >= 2 || request.signal.aborted) throw error
      continue
    }
    if ((edge || retryThumbnail) && response.status >= 500)
      console.warn('media_upstream_attempt_failed', {
        id: correlationId,
        attempt: attempt + 1,
        phase: 'headers',
        status: response.status,
        elapsedMs: Math.round(performance.now() - authorizationStarted),
      })
    if (
      !retryThumbnail ||
      attempt >= 2 ||
      request.signal.aborted ||
      ![502, 503, 504].includes(response.status)
    )
      break
    await response.body?.cancel()
  }
  if (response.headers.get('x-photo-media-transfer') === 'preview-batch-v1') {
    if (!previewBatch || !response.ok) {
      await response.body?.cancel()
      throw Error('Unexpected preview manifest')
    }
    response = await deliverPreviewBatch(request, response, env, fetcher)
  }
  if (response.headers.get('x-photo-media-transfer') === 'public-sql-v2') {
    if (!edge || !response.ok) {
      await response.body?.cancel()
      throw Error('Unexpected media grant')
    }
    const authorizationMs = performance.now() - authorizationStarted
    try {
      response = await deliverMedia(request, response, env, fetcher)
      response.headers.append('Server-Timing', `media_auth;dur=${authorizationMs.toFixed(1)}`)
    } catch (/** @type {any} */ error) {
      if (request.signal.aborted) throw error
      // A signing/storage failure must not interrupt otherwise working playback.
      // Re-enter the normal endpoint, including a fresh live authorization check.
      console.warn(
        'media_edge_fallback',
        /^Media [a-z ]+$/.test(error?.message ?? '') ? error.message : 'transport',
      )
      headers.delete('x-photo-media-transfer')
      if (session)
        headers.set('x-photo-gateway-identity', await identityAssertion(session, env, request))
      attempts++
      response = await mediaFetch(upstream.toString(), {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: request.signal,
      })
    }
  }
  const outgoing = new Headers(response.headers)
  outgoing.set('X-Request-ID', correlationId)
  if (edge || retryThumbnail) outgoing.set('X-Media-Upstream-Attempts', String(attempts))
  alignMapReportPolicy(outgoing)
  const location = outgoing.get('location')
  if (location) {
    const target = new URL(location, origin)
    if (target.origin !== origin.origin || target.pathname.startsWith('/sfc-endpoint/'))
      return new Response('Gallery connection needs administrator attention.', {
        status: 502,
        headers: { 'Cache-Control': 'no-store' },
      })
    outgoing.set('location', env.GATEWAY_ORIGIN + target.pathname + target.search + target.hash)
  }
  // oxlint-disable-next-line unicorn/no-useless-spread -- iterate a copy; the loop edits headers
  for (const [name, value] of [...outgoing]) {
    if (/^(?:sf-|x-snowflake|x-photo-)/i.test(name)) outgoing.delete(name)
    else if (value.includes(origin.hostname) && name !== 'location')
      outgoing.set(name, value.replaceAll(origin.hostname, new URL(env.GATEWAY_ORIGIN).hostname))
  }
  // Only the gallery's own activity cookie may cross the gateway boundary.
  const cookies = response.headers.getSetCookie?.() ?? []
  outgoing.delete('set-cookie')
  for (const c of cookies)
    if (c.startsWith('gallery_activity='))
      outgoing.append('set-cookie', c.replace(/;\s*Domain=[^;]+/gi, ''))
  if (!session || !hasRevalidatedThumbnailPolicy(request, response))
    outgoing.set('Cache-Control', 'private, no-store')
  if (
    session &&
    env.UPLOAD_SERVICE_CANARY === 'true' &&
    source.pathname === '/admin/upload' &&
    request.method === 'GET' &&
    response.ok
  ) {
    const enabled = source.searchParams.get('uploadServiceCanary') === '1'
    outgoing.append(
      'set-cookie',
      `upload_service_canary=${enabled ? '1' : ''}; Path=/api/upload; HttpOnly; Secure; SameSite=Strict; Max-Age=${enabled ? 900 : 0}`,
    )
  }
  outgoing.set('Referrer-Policy', 'no-referrer')
  return new Response(response.body, { status: response.status, headers: outgoing })
}
