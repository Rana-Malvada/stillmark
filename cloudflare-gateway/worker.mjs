import { isPublicBrandingRequest } from '../lib/branding.mjs'
import { publicShareRoute } from './public-share-route.mjs'
import { accountLanding, credentialEvent } from './customer-accounts.mjs'
import { credentialLog } from './credential-log.mjs'
import { mapTile } from '../lib/map-tiles.mjs'
import { recordDiagnostics } from './diagnostics.mjs'
import { checkAlerts } from './alerts.mjs'

export { EmailAlerts } from './alerts.mjs'
export { RevokedSession } from './session-revocation.mjs'
import { checkRenewal, gatewayToken } from './token-renewal.mjs'

export { GatewayTokenStore } from './token-renewal.mjs'
import { handleAuth, readSession, renewSessionResponse } from './auth.mjs'
import { proxyGallery } from './proxy.mjs'
import { rateLimitBucket, rateLimited, tooManyRequests } from './rate-limit.mjs'

const worker = {
  /**
   * @param {ScheduledController} event
   * @param {Env} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(event, env, ctx) {
    if (event.cron === '17 * * * *') ctx.waitUntil(checkRenewal(env))
    else ctx.waitUntil(checkAlerts(env))
  },
  /**
   * @param {Request} request
   * @param {Env} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const url = new URL(request.url)
    const headers = {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    }
    if (url.origin !== env.GATEWAY_ORIGIN) {
      return new Response('Unknown address', { status: 404, headers })
    }
    // Serve only public branding from Cloudflare, without Snowflake or authentication calls.
    if (isPublicBrandingRequest(url.pathname, request.method)) {
      if (!env.BRANDING_ASSETS) return new Response('Icon unavailable', { status: 503, headers })
      const asset = await env.BRANDING_ASSETS.fetch(request)
      const response = new Response(asset.body, asset)
      response.headers.set('Cache-Control', 'public, max-age=86400')
      response.headers.set('X-Content-Type-Options', 'nosniff')
      return response
    }
    const isPublicShare =
      publicShareRoute(url.pathname, request.method) && env.GALLERY_ENABLED === 'true'
    const bucket = rateLimitBucket(url.pathname, isPublicShare)
    if (bucket && (await rateLimited(request, env, bucket))) return tooManyRequests(headers)
    // The public endpoint authenticates an expiring album capability, never a user identity.
    if (isPublicShare) {
      try {
        return await proxyGallery(request, { ...env, SNOWFLAKE_PAT: await gatewayToken(env) }, null)
      } catch {
        return new Response('Shared album unavailable', { status: 502, headers })
      }
    }
    if (env.AUTH0_CLIENT_SECRET && env.SESSION_KEY) {
      const log = await credentialLog(request, env)
      if (log) return log
      const event = await credentialEvent(request, env)
      if (event) return event
      const auth = await handleAuth(request, env)
      if (auth) return auth
      const session = await readSession(request, env)
      if (!session) {
        if (
          env.CUSTOMER_ACCOUNTS_ENABLED === 'true' &&
          request.method === 'GET' &&
          url.pathname === '/'
        )
          return accountLanding(env)
        if (request.method !== 'GET' || url.pathname.startsWith('/api/'))
          return new Response('Sign in required', { status: 401, headers })
        return new Response(null, {
          status: 303,
          headers: { ...headers, Location: env.GATEWAY_ORIGIN + '/auth/start' },
        })
      }
      if (url.pathname.startsWith('/api/tiles/'))
        return mapTile(request, env.GATEWAY_ORIGIN, fetch, caches.default)
      if (url.pathname === '/api/auth/logout-url')
        return Response.json(
          { url: env.GATEWAY_ORIGIN + '/auth/logout' },
          { headers: { 'Cache-Control': 'no-store' } },
        )
      if (
        env.GALLERY_ENABLED === 'true' &&
        (env.GATEWAY_TOKENS || env.SNOWFLAKE_PAT) &&
        env.GATEWAY_SIGNING_KEY
      ) {
        try {
          const response = await proxyGallery(
            request,
            { ...env, SNOWFLAKE_PAT: await gatewayToken(env) },
            session,
          )
          return await renewSessionResponse(request, response, env, session)
        } catch {
          return new Response('Gallery connection unavailable. Please retry.', {
            status: 502,
            headers,
          })
        }
      }
      return new Response(
        'Sign-in verified. Your individual login is connected; gallery integration is still being tested.',
        { headers },
      )
    }
    if (url.pathname === '/healthz' && request.method === 'GET') {
      return new Response('Gateway reachable; gallery connection pending.', { headers })
    }
    return new Response(
      'Stillmark is being connected. Please use your existing gallery link for now.',
      {
        status: 503,
        headers: { ...headers, 'Retry-After': '3600' },
      },
    )
  },
}

export default {
  ...worker,
  /**
   * @param {Request} request
   * @param {Env} env
   */
  async fetch(request, env) {
    const started = performance.now()
    let response
    try {
      return (response = await worker.fetch(request, env))
    } finally {
      recordDiagnostics(request, env, response, performance.now() - started)
    }
  },
}
