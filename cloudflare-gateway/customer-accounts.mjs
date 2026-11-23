import { credentialReceipt } from './credential-receipt.mjs'
import { BRAND_ICON_LINKS } from '../lib/branding.mjs'
import { proxyGallery } from './proxy.mjs'
import { gatewayToken } from './token-renewal.mjs'
import { deliverCredential, retainCredential } from './credential-delivery.mjs'

const privateHeaders = {
  'Cache-Control': 'no-store',
  'Content-Type': 'text/html; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
}
/**
 * @param {Env} env
 * @param {string} [message]
 * @param {number} [status]
 */
export function accountLanding(env, message = '', status = 200) {
  // Form submissions follow redirects to Auth0. Allow only the configured login
  // host as well as this origin; never accept a destination from request data.
  const loginOrigin = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(env.AUTH0_DOMAIN ?? '')
    ? ` https://${env.AUTH0_DOMAIN}`
    : ''
  const headers = {
    ...privateHeaders,
    'Content-Security-Policy': privateHeaders['Content-Security-Policy'].replace(
      "form-action 'self'",
      `form-action 'self'${loginOrigin}`,
    ),
  }
  // All HTML strings here are application literals; no request/identity data is interpolated.
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stillmark</title>${BRAND_ICON_LINKS}
  <style>body{margin:0;background:#211f1b;color:#f5f2eb;font:17px system-ui;display:grid;min-height:100dvh;place-items:center}main{max-width:30rem;padding:2rem}h1{font-size:2.5rem}p{line-height:1.6;color:#ccc3b5}button,a{display:inline-block;margin:.4rem .6rem .4rem 0;padding:.8rem 1.2rem;border:1px solid #a38b61;border-radius:.6rem;color:#efbd6d;text-decoration:none}button:first-of-type{background:#efbd6d;color:#211f1b}label{display:flex;align-items:center;gap:.6rem;margin:1.2rem 0;font-size:16px}input{width:20px;height:20px;accent-color:#efbd6d}button{font:inherit;cursor:pointer;background:transparent}</style>
  <main><h1>Stillmark</h1><p>Your photos. Your memories. Your private library.</p>${message}
  <form action="/auth/start" method="get"><label><input type="checkbox" name="remember" value="1" checked>Keep me logged in on this computer for 30 days</label><button type="submit">Sign in</button>${env.PUBLIC_SIGNUP_ENABLED === 'true' ? '<button type="submit" formaction="/auth/signup">Create account</button>' : ''}</form>
  <p>Forgot your password? Choose Sign in, then Forgot password. Auth0 will email you a secure reset link.</p></main></html>`,
    { status, headers },
  )
}

/**
 * @param {Env} env
 * @param {boolean} verified
 */
export function accountBootstrapMessage(env, verified) {
  const message = verified
    ? '<h2>We couldn’t finish signing you in</h2><p>Please try signing in again. If this continues, contact the Stillmark administrator.</p>'
    : '<h2>Check your email to finish creating your account</h2><p>Open the verification email and select the verification link. Then return here and choose Sign in. If you don’t see the email, check your spam or junk folder.</p>'
  return accountLanding({ ...env, PUBLIC_SIGNUP_ENABLED: 'false' }, message)
}

/**
 * Emails are login identifiers, not public vanity names.
 * @param {import('jose').JWTPayload} claims
 */
export function initialDisplayName(claims) {
  const chosen = claims['https://stillmark.app/username']
  if (typeof chosen === 'string' && chosen.trim()) return chosen.trim().slice(0, 120)
  const name = claims.name
  return typeof name === 'string' && name.trim() && !name.includes('@')
    ? name.trim().slice(0, 120)
    : 'Member'
}

/**
 * @param {Env} env
 * @param {Session} session
 * @param {import('jose').JWTPayload} claims Verified ID token claims.
 */
export async function bootstrapAccount(env, session, claims) {
  const request = new Request(env.GATEWAY_ORIGIN + '/api/account/bootstrap', {
    method: 'POST',
    headers: { origin: env.GATEWAY_ORIGIN },
    signal: AbortSignal.timeout(15000),
  })
  return proxyGallery(
    request,
    { ...env, SNOWFLAKE_PAT: await gatewayToken(env) },
    {
      ...session,
      onboarding: {
        issuer: claims.iss,
        email: typeof claims.email === 'string' ? claims.email : '',
        displayName: initialDisplayName(claims),
        verified: claims.email_verified === true,
      },
    },
  )
}

/**
 * Auth0 Action endpoint. The public client cannot select a subject or mint a credential event.
 * @param {Request} request
 * @param {Env} env
 */
export async function credentialEvent(request, env) {
  if (new URL(request.url).pathname !== '/auth/credential-change') return null
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' }
  if (env.CUSTOMER_ACCOUNTS_ENABLED !== 'true' || request.method !== 'POST')
    return new Response('Not found', { status: 404, headers })
  if (!/^[a-f0-9]{64}$/.test(env.AUTH0_EVENT_KEY ?? ''))
    return new Response('Retry credential event', { status: 503, headers })
  let timestamp
  let event
  try {
    timestamp = Number(request.headers.get('x-stillmark-time'))
    const signature = request.headers.get('x-stillmark-signature') ?? ''
    if (
      !Number.isSafeInteger(timestamp) ||
      Math.abs(Date.now() / 1000 - timestamp) > 60 ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      throw Error('Invalid event')
    const reader = request.body?.getReader()
    if (!reader) throw Error('Missing event')
    const chunks = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 2048) {
          await reader.cancel()
          throw Error('Oversize event')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of chunks) {
      bytes.set(part, offset)
      offset += part.length
    }
    const body = new TextDecoder().decode(bytes)
    const key = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(
        // Checked above to be 64 hex characters, so it is set and always matches.
        /** @type {string[]} */ (/** @type {string} */ (env.AUTH0_EVENT_KEY).match(/../g)),
        (v) => parseInt(v, 16),
      ),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    if (
      !(await crypto.subtle.verify(
        'HMAC',
        key,
        // Also 64 hex characters, checked above.
        Uint8Array.from(/** @type {string[]} */ (signature.match(/../g)), (v) => parseInt(v, 16)),
        new TextEncoder().encode(`${timestamp}.${body}`),
      ))
    )
      throw Error('Invalid signature')
    event = JSON.parse(body)
    if (
      event.issuer !== `https://${env.AUTH0_DOMAIN}/` ||
      typeof event.subject !== 'string' ||
      !event.subject.startsWith('auth0|') ||
      event.subject.length > 200 ||
      !Number.isSafeInteger(event.changedAt) ||
      event.changedAt < 1 ||
      event.changedAt > timestamp + 5
    )
      throw Error('Invalid identity')
  } catch {
    return new Response('Invalid credential event', { status: 401, headers })
  }
  // Once authenticated, transport, token renewal and persistence failures are
  // retryable infrastructure errors, not evidence of a forged Auth0 event.
  try {
    await deliverCredential(event, env, 2500)
    await credentialReceipt(event, env, 'action', 'persisted')
    return Response.json(
      { accepted: true, persisted: true },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch {
    try {
      await retainCredential(event, env)
      await credentialReceipt(event, env, 'action', 'durable')
      return Response.json(
        { accepted: true, durable: true },
        { status: 202, headers: { 'Cache-Control': 'no-store' } },
      )
    } catch {
      return new Response('Retry credential event', { status: 503, headers })
    }
  }
}

/**
 * Recovery must start a new PKCE flow; never replay a failed callback.
 * @param {Env} env
 * @param {boolean} [expired]
 */
export function signInRecovery(env, expired = false) {
  const message = expired
    ? '<h2>Please start sign-in again</h2><p>Your sign-in session expired or is no longer available. If you just created an account, you can sign in with it below.</p>'
    : '<h2>We couldn’t finish signing you in</h2><p>Please try signing in again. If you just created an account, use that account rather than creating another one.</p>'
  return accountLanding({ ...env, PUBLIC_SIGNUP_ENABLED: 'false' }, message, 401)
}
