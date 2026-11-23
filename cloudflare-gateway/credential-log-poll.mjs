import { passwordChangeFromLog } from './credential-log-event.mjs'
import { credentialReceipt } from './credential-receipt.mjs'

const STATE = 'credential-log-poll:v1'
const INTERVAL = 240000
const RETENTION_WARNING = 20 * 3600000
const POLL_ERRORS = new Set([
  'configuration',
  'authorization',
  'rate_limited',
  'retrieval',
  'invalid_response',
  'invalid_checkpoint',
  'queue',
  'recovery_failed',
])
/**
 * @typedef {{ value: string, expires: number }} AccessToken
 * @typedef {{
 *   firstAttempt: number,
 *   lastAttempt?: number,
 *   nextAttempt?: number,
 *   lastDrained?: number,
 *   gapDetectedAt?: number,
 *   cursor?: string | null,
 *   error?: string | null,
 *   more?: boolean,
 * }} PollState
 * @typedef {{
 *   enabled: boolean,
 *   healthy: boolean,
 *   lastDrained: number | null,
 *   more: boolean,
 *   error: string | null,
 *   gapDetectedAt: number | null,
 * }} PollStatus
 */

/**
 * @param {unknown} id
 * @returns {id is string}
 */
const validId = (id) => typeof id === 'string' && /^\d{1,100}$/.test(id)

/**
 * @param {Response} response
 * @returns {Promise<any>} Parsed, untrusted provider data.
 */
async function json(response) {
  const reader = response.body?.getReader()
  if (!reader) throw Error('Empty response')
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 2097152) {
        await reader.cancel()
        throw Error('Oversize response')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** Independent of the app/Action: the existing cron pulls Auth0's ordered log.
 * A checkpoint advances only after every successful change is durably queued.
 * No additional worker, database, or log-stream subscription is required.
 */
export class CredentialLogPoll {
  /**
   * @param {DurableObjectState} ctx
   * @param {Env} env
   * @param {(event: CredentialEvent) => Promise<Response>} enqueue
   * @param {Fetch} [request]
   * @param {() => number} [now]
   */
  constructor(ctx, env, enqueue, request = (...args) => fetch(...args), now = Date.now) {
    this.ctx = ctx
    this.env = env
    this.enqueue = enqueue
    this.request = request
    this.now = now
    /** @type {Promise<PollStatus> | null} */
    this.running = null
    /** @type {AccessToken | null} */
    this.token = null
  }
  poll() {
    if (!this.running)
      this.running = this.run()
        .then((status) => {
          try {
            // Operational health only: never log identities, cursors, provider bodies or secrets.
            console.info(
              JSON.stringify({
                event: 'stillmark_credential_log_poll',
                version: 1,
                enabled: status.enabled === true,
                healthy: status.healthy === true,
                error:
                  status.error === null
                    ? null
                    : POLL_ERRORS.has(status.error)
                      ? status.error
                      : 'recovery_failed',
                more: status.more === true,
                lastDrained: Number.isFinite(status.lastDrained) ? status.lastDrained : null,
                gapDetectedAt: Number.isFinite(status.gapDetectedAt) ? status.gapDetectedAt : null,
              }),
            )
          } catch {
            // An unavailable log sink must not alter durable delivery or its acknowledgement.
          }
          return status
        })
        .finally(() => {
          this.running = null
        })
    return this.running
  }
  /** @returns {Promise<PollStatus>} */
  async status() {
    /** @type {PollState | undefined} */
    const s = await this.ctx.storage.get(STATE)
    return {
      enabled: this.env.AUTH0_LOG_POLL_ENABLED === 'true',
      healthy:
        !!s?.lastDrained && this.now() - s.lastDrained < 900000 && !s.error && !s.gapDetectedAt,
      lastDrained: s?.lastDrained ?? null,
      more: s?.more ?? true,
      error: s?.error ?? null,
      gapDetectedAt: s?.gapDetectedAt ?? null,
    }
  }
  /** @param {string} origin */
  async accessToken(origin) {
    // With no token held the optional chain yields undefined, which compares false.
    if (/** @type {number} */ (this.token?.expires) > this.now() + 60000)
      return /** @type {AccessToken} */ (this.token).value
    // Workers supports manual/follow, not redirect:'error'. Manual plus !ok rejects
    // redirects without forwarding the client secret or bearer token to another host.
    const r = await this.request(origin + '/oauth/token', {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.env.AUTH0_LOG_CLIENT_ID,
        client_secret: this.env.AUTH0_LOG_CLIENT_SECRET,
        audience: origin + '/api/v2/',
      }),
    })
    if (!r.ok) throw Error('authorization')
    const data = await json(r)
    if (
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      !Number.isSafeInteger(data.expires_in) ||
      data.expires_in < 60 ||
      data.expires_in > 2592000 ||
      data.token_type?.toLowerCase() !== 'bearer'
    )
      throw Error('authorization')
    this.token = { value: data.access_token, expires: this.now() + data.expires_in * 1000 }
    return this.token.value
  }
  async run() {
    if (this.env.AUTH0_LOG_POLL_ENABLED !== 'true') return this.status()
    const now = this.now()
    /** @type {PollState} */
    let state = /** @type {PollState | undefined} */ (await this.ctx.storage.get(STATE)) ?? {
      firstAttempt: now,
    }
    if (now < (state.nextAttempt ?? 0)) return this.status()
    state = { ...state, lastAttempt: now, nextAttempt: now + INTERVAL }
    if (now - (state.lastDrained ?? state.firstAttempt) > RETENTION_WARNING)
      state.gapDetectedAt ??= now
    await this.ctx.storage.put(STATE, state)
    try {
      const domain = this.env.AUTH0_LOG_TENANT_DOMAIN
      if (
        !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.auth0\.com$/.test(domain ?? '') ||
        !this.env.AUTH0_LOG_CLIENT_ID ||
        !this.env.AUTH0_LOG_CLIENT_SECRET
      )
        throw Error('configuration')
      const origin = 'https://' + domain
      for (let page = 0; page < 4; page++) {
        const query = state.cursor ? `from=${state.cursor}&take=100` : 'sort=log_id%3A1&per_page=1'
        const r = await this.request(origin + '/api/v2/logs?' + query, {
          headers: { Authorization: 'Bearer ' + (await this.accessToken(origin)) },
          redirect: 'manual',
          signal: AbortSignal.timeout(10000),
        })
        if (r.status === 401) this.token = null
        if (r.status === 429) {
          const delay = Number(r.headers.get('retry-after'))
          state.nextAttempt =
            now +
            Math.max(300000, Math.min(3600000, Number.isFinite(delay) ? delay * 1000 : 300000))
          throw Error('rate_limited')
        }
        if (!r.ok) throw Error('retrieval')
        const logs = await json(r)
        if (!Array.isArray(logs) || logs.length > (state.cursor ? 100 : 1))
          throw Error('invalid_response')
        let previous = state.cursor
        const events = []
        for (const log of logs) {
          if (!validId(log?.log_id) || (previous && BigInt(log.log_id) <= BigInt(previous)))
            throw Error('invalid_checkpoint')
          previous = log.log_id
          const event = passwordChangeFromLog(log, this.env, now)
          if (event) events.push(event)
        }
        let cursor = previous
        const link = r.headers.get('link')?.match(/<([^>]+)>;\s*rel="?next"?/)
        if (state.cursor && !link) throw Error('invalid_checkpoint')
        if (link) {
          const url = new URL(link[1])
          cursor = url.searchParams.get('from')
          if (
            url.origin !== origin ||
            url.pathname !== '/api/v2/logs' ||
            !validId(cursor) ||
            (previous && BigInt(cursor) !== BigInt(previous))
          )
            throw Error('invalid_checkpoint')
        }
        for (const event of events) {
          const accepted = await this.enqueue(event)
          if (accepted.status !== 202 || (await accepted.json()).durable !== true)
            throw Error('queue')
          await credentialReceipt(event, this.env, 'log-poll', 'durable')
        }
        state = { ...state, cursor: cursor ?? null, error: null, more: logs.length !== 0 }
        if (!logs.length) state.lastDrained = this.now()
        await this.ctx.storage.put(STATE, state)
        if (!logs.length) break
      }
    } catch (/** @type {any} */ error) {
      // No upstream bodies, identity details or tokens enter persisted errors/logs.
      state.error = POLL_ERRORS.has(error?.message) ? error.message : 'recovery_failed'
      await this.ctx.storage.put(STATE, state)
    }
    return this.status()
  }
}
