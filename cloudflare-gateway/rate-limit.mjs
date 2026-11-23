// Per-client request ceilings for the entry points that need no session: sign-in
// and public share links. Limits are enforced by Cloudflare's rate limiting binding,
// keyed by client address. They bound cost and brute-force attempts; they are not the
// control that protects data (sessions and 256-bit share tokens are).

/**
 * Which ceiling applies to a request, or null when the route is not limited here.
 * @param {string} pathname
 * @param {boolean} isPublicShare
 * @returns {'share' | 'auth' | null}
 */
export function rateLimitBucket(pathname, isPublicShare) {
  if (isPublicShare) return 'share'
  if (pathname.startsWith('/auth/')) return 'auth'
  return null
}

/**
 * True when the client has exceeded the ceiling for this bucket. A missing binding
 * or a limiter error allows the request: availability of sign-in must not depend on
 * the limiter, and Auth0 applies its own attack protection behind it.
 * @param {Request} request
 * @param {Env} env
 * @param {'share' | 'auth'} bucket
 */
export async function rateLimited(request, env, bucket) {
  const limiter = bucket === 'auth' ? env.AUTH_RATE_LIMIT : env.SHARE_RATE_LIMIT
  if (!limiter) return false
  const client = request.headers.get('cf-connecting-ip') || 'unknown'
  try {
    const { success } = await limiter.limit({ key: `${bucket}:${client}` })
    return !success
  } catch {
    return false
  }
}

/** @param {Record<string, string>} headers */
export function tooManyRequests(headers) {
  return new Response('Too many requests. Please wait a minute and try again.', {
    status: 429,
    headers: { ...headers, 'Retry-After': '60' },
  })
}
