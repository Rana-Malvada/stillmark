import { REMEMBERED_SESSION_SECONDS } from './session-policy.mjs'
import {
  accountBootstrapMessage,
  accountLanding,
  bootstrapAccount,
  signInRecovery,
} from './customer-accounts.mjs'
import { hasRevalidatedThumbnailPolicy } from '../lib/thumbnail-cache.mjs'
import { deployment } from '../config/deployment.mjs'
import { proxyGallery } from './proxy.mjs'
import { gatewayToken } from './token-renewal.mjs'
import { isRevoked, revokeSession } from './session-revocation.mjs'
import { createRemoteJWKSet, EncryptJWT, jwtDecrypt, jwtVerify } from 'jose'

export const SESSION_IDLE_SECONDS = 3600
export const SESSION_MAX_SECONDS = 12 * 3600
const encoder = new TextEncoder()
/** @type {Map<string, ReturnType<typeof createRemoteJWKSet>>} */
const keys = new Map()
const random = () => crypto.randomUUID() + crypto.randomUUID()
/**
 * @param {string} name
 * @param {string | null} value
 * @param {number} age
 */
const cookie = (name, value, age) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`
/**
 * @param {Request} request
 * @param {string} name
 */
function readCookie(request, name) {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith(name + '='))
    ?.slice(name.length + 1)
}
/** @param {Env} env */
function config(env) {
  const origin = new URL(env.GATEWAY_ORIGIN)
  if (
    origin.protocol !== 'https:' ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw Error('Configuration')
  if (
    env.AUTH0_DOMAIN !== deployment.AUTH0_DOMAIN &&
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.auth0\.com$/.test(env.AUTH0_DOMAIN ?? '')
  )
    throw Error('Configuration')
  if (
    !env.AUTH0_CLIENT_ID ||
    !env.AUTH0_CLIENT_SECRET ||
    !/^[0-9a-f]{64}$/.test(env.SESSION_KEY ?? '')
  )
    throw Error('Configuration')
  const key = Uint8Array.from(
    // Checked above to be 64 hex characters, so it is set and always matches.
    /** @type {string[]} */ (/** @type {string} */ (env.SESSION_KEY).match(/../g)),
    (v) => parseInt(v, 16),
  )
  return { origin: origin.origin, issuer: `https://${env.AUTH0_DOMAIN}/`, key }
}
/**
 * @param {import('jose').JWTPayload} data
 * @param {Uint8Array} key
 * @param {string} subject
 * @param {number} seconds
 * @param {number} [absoluteExpiresAt]
 * @returns {Promise<string | null>} Null when the deadline has already passed.
 */
async function seal(data, key, subject, seconds, absoluteExpiresAt = Infinity) {
  const issuedAt = Math.floor(Date.now() / 1000)
  // Async bootstrap and encryption must never move the original login deadline.
  const expiresAt = Math.min(issuedAt + seconds, absoluteExpiresAt)
  if (expiresAt <= issuedAt) return null
  return new EncryptJWT(data)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setSubject(subject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .encrypt(key)
}
/**
 * @param {string | undefined} token
 * @param {Uint8Array} key
 * @param {string} subject
 * @returns {Promise<unknown>} Decrypted claims; each caller states the shape it sealed.
 */
async function unseal(token, key, subject) {
  if (!token) throw Error('Missing session')
  return (await jwtDecrypt(token, key, { subject, clockTolerance: 5 })).payload
}
/**
 * @param {string} location
 * @param {string[]} [cookies]
 */
function redirect(location, cookies = []) {
  const h = new Headers({
    Location: location,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  })
  cookies.forEach((c) => h.append('Set-Cookie', c))
  return new Response(null, { status: 303, headers: h })
}
/**
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response | null>} Null when the request is not an `/auth/` route.
 */
export async function handleAuth(request, env) {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/auth/')) return null
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
  let c
  try {
    c = config(env)
  } catch {
    return new Response('Sign-in is being connected.', {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  if (url.origin !== c.origin) return new Response('Invalid origin', { status: 403 })
  if (url.pathname === '/auth/recover') return accountLanding(env)
  if (url.pathname === '/auth/start' || url.pathname === '/auth/signup') {
    const signup = url.pathname === '/auth/signup'
    if (
      signup &&
      (env.PUBLIC_SIGNUP_ENABLED !== 'true' || env.CUSTOMER_ACCOUNTS_ENABLED !== 'true')
    )
      return new Response('Registration is closed', {
        status: 403,
        headers: { 'Cache-Control': 'no-store' },
      })
    const state = random()
    const nonce = random()
    const verifier = random()
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)))
    const challenge = btoa(String.fromCharCode(...digest))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')
    return redirect(c.origin + '/auth/continue', [
      cookie(
        '__Host-photo-flow',
        await seal(
          {
            state,
            nonce,
            verifier,
            challenge,
            signup,
            remember: url.searchParams.get('remember') === '1',
          },
          c.key,
          'login-flow',
          600,
        ),
        600,
      ),
    ])
  }
  if (url.pathname === '/auth/continue') {
    let flow
    try {
      flow = /** @type {LoginFlow} */ (
        await unseal(readCookie(request, '__Host-photo-flow'), c.key, 'login-flow')
      )
    } catch (/** @type {any} */ error) {
      console.error(
        'auth_flow_check_failed',
        readCookie(request, '__Host-photo-flow') ? 'invalid_cookie' : 'missing_cookie',
        error.code ?? 'unknown',
      )
      const response = signInRecovery(env, true)
      response.headers.append('Set-Cookie', cookie('__Host-photo-flow', '', 0))
      return response
    }
    const { state, nonce, challenge } = flow
    const target = new URL('authorize', c.issuer)
    target.search = new URLSearchParams({
      response_type: 'code',
      client_id: env.AUTH0_CLIENT_ID,
      redirect_uri: c.origin + '/auth/callback',
      scope: env.CUSTOMER_ACCOUNTS_ENABLED === 'true' ? 'openid profile email' : 'openid',
      ...(flow.signup ? { screen_hint: 'signup' } : {}),
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'login',
      connection: 'Username-Password-Authentication',
    }).toString()
    return redirect(target.toString())
  }
  if (url.pathname === '/auth/callback') {
    const clear = cookie('__Host-photo-flow', '', 0)
    let stage = 'flow_cookie'
    try {
      const flow = /** @type {LoginFlow} */ (
        await unseal(readCookie(request, '__Host-photo-flow'), c.key, 'login-flow')
      )
      stage = 'response_state'
      if (
        !url.searchParams.get('code') ||
        url.searchParams.get('state') !== flow.state ||
        url.searchParams.has('error')
      )
        throw Error('Invalid response')
      stage = 'token_exchange'
      const result = await fetch(new URL('oauth/token', c.issuer), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: env.AUTH0_CLIENT_ID,
          client_secret: env.AUTH0_CLIENT_SECRET,
          code: url.searchParams.get('code'),
          code_verifier: flow.verifier,
          redirect_uri: c.origin + '/auth/callback',
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      })
      if (!result.ok) throw Error('Token exchange')
      const body = await result.json()
      stage = 'token_verification'
      if (!keys.has(c.issuer))
        keys.set(c.issuer, createRemoteJWKSet(new URL('.well-known/jwks.json', c.issuer)))
      // The key set was stored on the line above when it was missing.
      const { payload } = await jwtVerify(
        body.id_token,
        /** @type {ReturnType<typeof createRemoteJWKSet>} */ (keys.get(c.issuer)),
        {
          issuer: c.issuer,
          audience: env.AUTH0_CLIENT_ID,
          algorithms: ['RS256'],
          requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
        },
      )
      if (
        payload.nonce !== flow.nonce ||
        typeof payload.sub !== 'string' ||
        (payload.azp && payload.azp !== env.AUTH0_CLIENT_ID)
      )
        throw Error('Identity mismatch')
      stage = 'session_creation'
      const startedAt = Math.floor(Date.now() / 1000)
      const absoluteExpiresAt = Math.min(
        startedAt + (flow.remember === true ? REMEMBERED_SESSION_SECONDS : SESSION_MAX_SECONDS),
        Number.isInteger(payload.session_expiry)
          ? /** @type {number} */ (payload.session_expiry)
          : Infinity,
      )
      if (absoluteExpiresAt <= startedAt) throw Error('Expired')
      if (env.CUSTOMER_ACCOUNTS_ENABLED === 'true') {
        stage = 'account_bootstrap'
        const result = await bootstrapAccount(
          env,
          { auth0Subject: payload.sub, sid: crypto.randomUUID(), startedAt },
          payload,
        )
        if (!result.ok) {
          const response = accountBootstrapMessage(env, payload.email_verified === true)
          response.headers.append('Set-Cookie', clear)
          response.headers.append('Set-Cookie', cookie('__Host-photo-session', '', 0))
          return response
        }
      }
      const age = Math.min(
        flow.remember === true ? REMEMBERED_SESSION_SECONDS : SESSION_IDLE_SECONDS,
        absoluteExpiresAt - Math.floor(Date.now() / 1000),
      )
      const token = await seal(
        {
          auth0Subject: payload.sub,
          sid: crypto.randomUUID(),
          startedAt,
          absoluteExpiresAt,
          remember: flow.remember === true,
          revocationBackend:
            env.SESSION_REVOCATION_BACKEND === 'postgres' ? 'postgres' : 'durable-object',
        },
        c.key,
        'gallery-session',
        age,
        absoluteExpiresAt,
      )
      if (!token) throw Error('Expired')
      return redirect(c.origin + '/', [clear, cookie('__Host-photo-session', token, age)])
    } catch (/** @type {any} */ error) {
      console.error(
        'auth_callback_failed',
        stage,
        error.name ?? 'Error',
        error.code ?? 'unknown',
        String(error.message ?? '')
          .replace(/https?:\/\/\S+/g, '[url]')
          .slice(0, 160),
        readCookie(request, '__Host-photo-flow') ? 'cookie_present' : 'cookie_missing',
      )
      const response = signInRecovery(env, stage === 'flow_cookie')
      response.headers.append('Set-Cookie', clear)
      return response
    }
  }
  if (url.pathname === '/auth/logout') {
    if (request.headers.get('sec-fetch-site') === 'cross-site')
      return new Response('Forbidden', { status: 403 })
    /** @type {Session | undefined} */
    let session
    try {
      session = /** @type {Session} */ (
        await unseal(readCookie(request, '__Host-photo-session'), c.key, 'gallery-session')
      )
    } catch {}
    if (session) {
      try {
        if (
          env.SESSION_REVOCATION_BACKEND === 'postgres' ||
          session.revocationBackend === 'postgres'
        ) {
          const request = new Request(c.origin + '/api/auth/revoke-session', {
            method: 'POST',
            headers: { Origin: c.origin },
          })
          const response = await proxyGallery(
            request,
            { ...env, SNOWFLAKE_PAT: await gatewayToken(env) },
            session,
          )
          if (!response.ok || (await response.json()).revoked !== true)
            throw Error('Session revocation unavailable')
        } else await revokeSession(env, session.sid)
      } catch {
        return new Response('Logout could not be completed. Please retry.', {
          status: 503,
          headers: { 'Cache-Control': 'no-store' },
        })
      }
    }
    const dest = new URL('v2/logout', c.issuer)
    dest.search = new URLSearchParams({
      client_id: env.AUTH0_CLIENT_ID,
      returnTo: c.origin + '/',
    }).toString()
    return redirect(dest.toString(), [
      cookie('__Host-photo-session', '', 0),
      cookie('__Host-photo-flow', '', 0),
    ])
  }
  return new Response('Not found', { status: 404 })
}

/**
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Session | null>}
 */
export async function readSession(request, env) {
  try {
    const c = config(env)
    // Only this gateway can produce a cookie that decrypts; sessionBounds checks the rest.
    const session = /** @type {Session} */ (
      await unseal(readCookie(request, '__Host-photo-session'), c.key, 'gallery-session')
    )
    sessionBounds(session)
    if (env.SESSION_REVOCATION_BACKEND === 'postgres' && session.revocationBackend === 'postgres')
      return session
    if (await isRevoked(env, session.sid)) return null
    // Check legacy revocation once before upgrading a still-valid cookie.
    if (env.SESSION_REVOCATION_BACKEND === 'postgres') session.revocationBackend = 'postgres'
    return session
  } catch {
    return null
  }
}

/** @param {Session} session */
function sessionBounds(session) {
  const now = Math.floor(Date.now() / 1000)
  // Existing valid one-hour cookies adopt a fixed ceiling anchored to original login.
  // Typed as numbers for the arithmetic; anything that is not an integer is rejected below.
  const startedAt = /** @type {number} */ (session.startedAt ?? session.iat)
  const absoluteExpiresAt = session.absoluteExpiresAt ?? startedAt + SESSION_MAX_SECONDS
  if (
    !Number.isInteger(startedAt) ||
    !Number.isInteger(absoluteExpiresAt) ||
    startedAt > now + 5 ||
    absoluteExpiresAt >
      startedAt + (session.remember === true ? REMEMBERED_SESSION_SECONDS : SESSION_MAX_SECONDS) ||
    absoluteExpiresAt <= now ||
    !Number.isInteger(session.exp) ||
    /** @type {number} */ (session.exp) <= now ||
    /** @type {number} */ (session.exp) > absoluteExpiresAt ||
    typeof session.auth0Subject !== 'string'
  )
    throw Error('Expired session')
  return { startedAt, absoluteExpiresAt }
}
/** @param {Request} request */
export function isSessionActivity(request) {
  const path = new URL(request.url).pathname
  if (
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    request.method === 'OPTIONS' ||
    request.headers.get('purpose') === 'prefetch' ||
    request.headers.get('sec-purpose')?.includes('prefetch')
  )
    return false
  // Passive telemetry and polling must not keep an abandoned tab signed in.
  if (
    path.startsWith('/auth/') ||
    path.startsWith('/_next/') ||
    path.startsWith('/api/activity') ||
    path.startsWith('/api/user-activity') ||
    path.startsWith('/api/health') ||
    path.startsWith('/api/status')
  )
    return false
  return true
}
/**
 * @param {Request} request
 * @param {Response} response
 * @param {Env} env
 * @param {Session} session
 */
export async function renewSessionResponse(request, response, env, session) {
  if (
    response.headers.get('X-Media-Authorization') === 'grant' ||
    !isSessionActivity(request) ||
    response.status >= 400
  )
    return response
  let bounds
  try {
    bounds = sessionBounds(session)
  } catch {
    return response
  }
  const { startedAt, absoluteExpiresAt } = bounds
  const age = Math.min(
    session.remember === true ? REMEMBERED_SESSION_SECONDS : SESSION_IDLE_SECONDS,
    absoluteExpiresAt - Math.floor(Date.now() / 1000),
  )
  const c = config(env)
  const token = await seal(
    {
      auth0Subject: session.auth0Subject,
      sid: session.sid,
      startedAt,
      absoluteExpiresAt,
      remember: session.remember === true,
      revocationBackend: session.revocationBackend ?? 'durable-object',
    },
    c.key,
    'gallery-session',
    age,
    absoluteExpiresAt,
  )
  if (!token) return response
  const headers = new Headers(response.headers)
  headers.append('Set-Cookie', cookie('__Host-photo-session', token, age))
  if (!hasRevalidatedThumbnailPolicy(request, response))
    headers.set('Cache-Control', 'private, no-store')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
