import { deployment } from '../config/deployment.mjs'
import { EncryptJWT, importPKCS8, jwtDecrypt, SignJWT } from 'jose'

const DAY = 86400000

/**
 * @typedef {{ encrypted: string, expiresAt: number, rotatedAt: number }} ActiveToken
 * @typedef {{ requestId: string, encrypted?: string, createdAt?: number }} PendingToken
 * @typedef {{ ok: boolean, rotated: boolean, expiresAt: number }} RenewalResult
 */

/** @param {any} error A caught value of any kind. */
function safeError(error) {
  const m = error?.message ?? ''
  return /^(Snowflake renewal request failed|Renewed credential failed|Invalid credential expiry|Renewal returned no credential|Invalid renewal response)/.test(
    m,
  )
    ? m
    : 'renewal_operation_failed'
}
const USER = deployment.GATEWAY_USER
const ROLE = deployment.RENEWAL_ROLE
const ACCOUNT = deployment.SNOWFLAKE_ACCOUNT
const API = deployment.SNOWFLAKE_API_ORIGIN + '/api/v2/statements'
const ROTATE = `ALTER USER ${USER} ROTATE PROGRAMMATIC ACCESS TOKEN ${deployment.GATEWAY_PAT_NAME} EXPIRE_ROTATED_TOKEN_AFTER_HOURS=24`
/** @param {Env} env */
async function encryptionKey(env) {
  if (!/^[a-f0-9]{64}$/.test(env.SESSION_KEY ?? ''))
    throw Error('Token storage configuration missing')
  return new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('gateway-token-storage:' + env.SESSION_KEY),
    ),
  )
}
/**
 * @param {string} token
 * @param {Env} env
 */
export async function sealToken(token, env) {
  return new EncryptJWT({ token })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .encrypt(await encryptionKey(env))
}
/**
 * @param {string} value
 * @param {Env} env
 */
export async function openToken(value, env) {
  const { payload } = await jwtDecrypt(value, await encryptionKey(env))
  if (typeof payload.token !== 'string' || !payload.token) throw Error('Invalid stored token')
  return payload.token
}
/** @param {Env} env */
async function authorization(env) {
  // An unset key is rejected by the import and fails the renewal.
  const key = await importPKCS8(/** @type {string} */ (env.SNOWFLAKE_RENEWAL_PRIVATE_KEY), 'RS256')
  const subject = ACCOUNT + '.' + USER
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(subject + '.' + env.SNOWFLAKE_RENEWAL_KEY_FP)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key)
}
// Fixed SQL and destination. Never accept SQL, usernames or URLs from public requests.
/**
 * @param {Env} env
 * @param {string} sql
 * @param {string} requestId
 * @param {Fetch} [fetcher]
 * @returns {Promise<Record<string, any>[]>} One object per row, keyed by lower-case column name.
 */
export async function statement(env, sql, requestId, fetcher = fetch) {
  const jwt = await authorization(env)
  const headers = {
    'User-Agent': 'PersonalPhotosTokenRenewal/1.0',
    Authorization: 'Bearer ' + jwt,
    'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  let response = await fetcher(API + '?requestId=' + requestId + '&retry=true', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      statement: sql,
      timeout: 10,
      role: ROLE,
      parameters: { query_tag: 'personal-photos-token-renewal' },
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  })
  for (let i = 0; response.status === 202 && i < 5; i++) {
    const body = await response.json()
    if (!/^[a-f0-9-]{36}$/i.test(body.statementHandle ?? ''))
      throw Error('Renewal statement unavailable')
    await new Promise((r) => setTimeout(r, 1000))
    response = await fetcher(API + '/' + body.statementHandle, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    })
  }
  if (!response.ok || response.status === 202) {
    const failure = await response.json().catch(() => null)
    throw Error(
      'Snowflake renewal request failed HTTP ' +
        response.status +
        ' code ' +
        (/^[0-9]+$/.test(failure?.code ?? '') ? failure.code : 'unknown'),
    )
  }
  const result = await response.json()
  if (!Array.isArray(result.data) || !Array.isArray(result.resultSetMetaData?.rowType))
    throw Error('Invalid renewal response')
  return result.data.map((/** @type {any[]} */ row) =>
    Object.fromEntries(
      result.resultSetMetaData.rowType.map(
        (/** @type {{ name: string }} */ col, /** @type {number} */ i) => [
          col.name.toLowerCase(),
          row[i],
        ],
      ),
    ),
  )
}
/**
 * @param {string} token
 * @param {Env} env
 * @param {Fetch} [fetcher]
 */
export async function verifyToken(token, env, fetcher = fetch) {
  // An unset origin throws here and fails the renewal.
  const url = new URL(/** @type {string} */ (env.SNOWFLAKE_ORIGIN))
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.snowflakecomputing.app') ||
    url.pathname !== '/'
  )
    throw Error('Invalid renewal origin')
  url.pathname = '/api/health/live'
  const response = await fetcher(url, {
    headers: { Authorization: `Snowflake Token="${token}"` },
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  })
  const body = await response.json().catch(() => null)
  if (response.status !== 200 || body?.status !== 'ok')
    throw Error('Renewed credential failed health check')
}
export class GatewayTokenStore {
  /**
   * @param {DurableObjectState} ctx
   * @param {Env} env
   * @param {{ statement: typeof statement, verifyToken: typeof verifyToken }} [operations]
   */
  constructor(ctx, env, operations = { statement, verifyToken }) {
    this.ctx = ctx
    this.env = env
    /** @type {Promise<RenewalResult | void> | null} */
    this.running = null
    this.operations = operations
  }
  /** @param {Request} request */
  async fetch(request) {
    // This class is reachable only through the Worker's private binding.
    const path = new URL(request.url).pathname
    if (path === '/status' && request.method === 'GET') {
      /** @type {ActiveToken | undefined} */
      const state = await this.ctx.storage.get('active')
      return Response.json({ expiresAt: state?.expiresAt ?? 0 })
    }
    if (path === '/check' && request.method === 'POST') {
      if (!this.running)
        this.running = this.renew().finally(() => {
          this.running = null
        })
      try {
        return Response.json(await this.running)
      } catch (error) {
        console.error('gateway_token_renewal_failed', safeError(error))
        return Response.json({ ok: false }, { status: 503 })
      }
    }
    if (path === '/token' && request.method === 'GET') {
      /** @type {ActiveToken | undefined} */
      const state = await this.ctx.storage.get('active')
      if (state && state.expiresAt > Date.now() + 60000)
        return new Response(await openToken(state.encrypted, this.env), {
          headers: { 'Cache-Control': 'no-store' },
        })
      // Bootstrap only. Never silently fall back to an obsolete secret after rotation.
      if (!state && this.env.SNOWFLAKE_PAT) {
        if (!this.running) {
          this.running = this.renew()
            .catch((error) => {
              console.error('gateway_token_renewal_failed', safeError(error))
            })
            .finally(() => {
              this.running = null
            })
          this.ctx.waitUntil(this.running)
        }
        return new Response(this.env.SNOWFLAKE_PAT, { headers: { 'Cache-Control': 'no-store' } })
      }
      return new Response('Credential unavailable', { status: 503 })
    }
    return new Response('Not found', { status: 404 })
  }
  /** @returns {Promise<RenewalResult>} */
  async renew() {
    /** @type {ActiveToken | undefined} */
    const state = await this.ctx.storage.get('active')
    if (state && state.expiresAt - Date.now() > 7 * DAY)
      return { ok: true, rotated: false, expiresAt: state.expiresAt }
    // Persist request ID before external mutation. An uncertain response is retried
    // with the same Snowflake request ID, not a second rotation.
    /** @type {PendingToken | undefined} */
    let pending = await this.ctx.storage.get('pending')
    if (!pending) {
      pending = { requestId: crypto.randomUUID() }
      await this.ctx.storage.put('pending', pending)
    }
    if (!pending.encrypted) {
      const rows = await this.operations.statement(this.env, ROTATE, pending.requestId)
      const token = rows[0]?.token_secret
      if (typeof token !== 'string' || !token) throw Error('Renewal returned no credential')
      pending = { ...pending, encrypted: await sealToken(token, this.env), createdAt: Date.now() }
      await this.ctx.storage.put('pending', pending)
    }
    // Present: either stored by an earlier attempt or set just above.
    const token = await openToken(/** @type {string} */ (pending.encrypted), this.env)
    await this.operations.verifyToken(token, this.env)
    const rows = await this.operations.statement(
      this.env,
      `SHOW USER PROGRAMMATIC ACCESS TOKENS FOR USER ${USER}`,
      crypto.randomUUID(),
    )
    const record = rows.find((x) => x.name === deployment.GATEWAY_PAT_NAME)
    const rawExpiry = record?.expires_at
    const expiresAt =
      typeof rawExpiry === 'string' && /^\d+(?:\.\d+)?$/.test(rawExpiry)
        ? Number(rawExpiry) * 1000
        : Date.parse(rawExpiry)
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now() + 7 * DAY)
      throw Error('Invalid credential expiry')
    await this.ctx.storage.transaction(async (tx) => {
      await tx.put('active', { encrypted: pending.encrypted, expiresAt, rotatedAt: Date.now() })
      await tx.delete('pending')
    })
    console.log('gateway_token_renewal_succeeded', new Date(expiresAt).toISOString())
    return { ok: true, rotated: true, expiresAt }
  }
}
/** @type {{ binding: DurableObjectNamespace, token: string, until: number } | undefined} */
let cached
/**
 * @param {Env} env
 * @returns {Promise<string | undefined>} Undefined only with no token store and no bootstrap secret.
 */
export async function gatewayToken(env) {
  if (!env.GATEWAY_TOKENS) {
    // Without either credential, fail closed instead of sending a meaningless token.
    if (!env.SNOWFLAKE_PAT) throw Error('Gateway credential unavailable')
    return env.SNOWFLAKE_PAT
  }
  if (cached?.binding === env.GATEWAY_TOKENS && cached.until > Date.now()) return cached.token
  const stub = env.GATEWAY_TOKENS.get(env.GATEWAY_TOKENS.idFromName('gateway'))
  const r = await stub.fetch('https://internal/token')
  if (!r.ok) throw Error('Gateway credential unavailable')
  const token = await r.text()
  cached = { binding: env.GATEWAY_TOKENS, token, until: Date.now() + 5 * 60000 }
  return token
}
/** @param {Env} env */
export async function checkRenewal(env) {
  const stub = env.GATEWAY_TOKENS.get(env.GATEWAY_TOKENS.idFromName('gateway'))
  const r = await stub.fetch('https://internal/check', { method: 'POST' })
  if (!r.ok) throw Error('Gateway token renewal failed')
  return r.json()
}
