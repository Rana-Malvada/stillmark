import { deployment } from '../config/deployment.mjs'

// Isolated tests only. Log phase timing and an opaque correlation ID, never
// URLs, signed storage credentials, request bodies, or authentication headers.
/**
 * @param {Request} request
 * @param {Env} env
 * @param {Fetch} fetcher
 * @param {{ DATABASE?: string }} [profile]
 * @param {(line: string) => void} [log]
 * @returns {Fetch}
 */
export function traceTransport(request, env, fetcher, profile = deployment, log = console.log) {
  const id = request.headers.get('x-load-test-request')
  if (
    env.LOAD_TEST_TRANSPORT_TRACE !== 'true' ||
    !/^STILLMARK_LOADTEST_[A-Z0-9_]+$/.test(profile.DATABASE ?? '') ||
    !/^https:\/\/stillmark-loadtest-[a-z0-9-]+(?:\.[a-z0-9-]+)?\.workers\.dev$/.test(
      env.GATEWAY_ORIGIN ?? '',
    ) ||
    !/^[a-f0-9-]{36}$/i.test(id ?? '')
  )
    return fetcher
  return async (url, init) => {
    const host = new URL(url)
    const phase = host.pathname.startsWith('/api/v2/statements')
      ? 'signing'
      : host.hostname.endsWith('.snowflakecomputing.app')
        ? 'app'
        : 'storage'
    const start = performance.now()
    let status = 0
    try {
      const response = await fetcher(url, init)
      status = response.status
      return response
    } finally {
      const ms = Math.round(performance.now() - start)
      if (ms >= 2000 || !status || status >= 500)
        log(JSON.stringify({ event: 'isolated_transport', id, phase, ms, status }))
    }
  }
}
