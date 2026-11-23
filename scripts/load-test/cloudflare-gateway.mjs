import gateway from '../../cloudflare-gateway/worker.mjs'
import { deployment } from '../../config/deployment.mjs'

/** Test entry point only. Cookies are provisioned offline; no login endpoint exists. */
export function isolatedGateway(worker, profile) {
  return {
    async fetch(request, env, ctx) {
      const origin = new URL(env.GATEWAY_ORIGIN ?? 'https://invalid.invalid')
      if (
        !/^STILLMARK_LOADTEST_[A-Z0-9_]+$/.test(profile.DATABASE ?? '') ||
        !/^stillmark_loadtest_[a-z0-9_]+$/.test(profile.PG_DATABASE ?? '') ||
        !origin.hostname.endsWith('.workers.dev') ||
        !origin.hostname.startsWith('stillmark-loadtest-') ||
        origin.origin !== profile.GATEWAY_ORIGIN ||
        env.SNOWFLAKE_ORIGIN !== profile.APP_ORIGIN ||
        env.UPLOAD_SERVICE_ORIGIN !== profile.APP_ORIGIN ||
        env.SESSION_REVOCATION_BACKEND !== 'postgres' ||
        env.AUTH0_DOMAIN !== 'disabled.example.invalid'
      )
        return new Response('Isolated gateway configuration required', { status: 503 })
      const url = new URL(request.url)
      if (url.origin !== origin.origin || !url.pathname.startsWith('/api/'))
        return new Response('Not found', { status: 404 })
      // No /auth/start, /auth/callback, shared links, scheduled tasks, or cookie issuer.
      // Ordinary API requests retain the production cookie/signature/session checks.
      const id = request.headers.get('x-load-test-request')
      const trace =
        env.RESET_TRACE &&
        ctx?.waitUntil &&
        Number(env.RESET_TRACE_UNTIL) > Date.now() &&
        Number(env.RESET_TRACE_UNTIL) < Date.now() + 30 * 60 * 1000 &&
        /^[a-f0-9-]{36}$/i.test(id ?? '')
      const record = (phase, status, timings = {}) => {
        if (!trace) return
        // Separate keys avoid KV's same-key write limit. Short-lived synthetic
        // evidence contains no URL, cookie, identity, body or media credentials.
        ctx.waitUntil(
          env.RESET_TRACE.put(
            `${id}:${phase}`,
            JSON.stringify({ id, phase, at: Date.now(), status, timings }),
            { expirationTtl: 600 },
          ).catch(() => console.error('isolated_receipt_write_failed', id, phase)),
        )
      }
      record('received', 0)
      try {
        const response = await worker.fetch(request, env)
        const timings = {}
        for (const match of (response.headers.get('server-timing') ?? '').matchAll(
          /(?:^|,)\s*(media_auth|media_sign|media_storage|app);dur=([0-9.]+)/g,
        )) {
          const value = Number(match[2])
          if (Number.isFinite(value)) timings[match[1]] = value
        }
        record('returned', response.status, timings)
        return response
      } catch (error) {
        record('threw', 0)
        throw error
      }
    },
  }
}

export default isolatedGateway(gateway, deployment)
