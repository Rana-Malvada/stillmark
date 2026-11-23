import { CredentialOutbox } from './credential-outbox.mjs'
import { credentialQueue } from './credential-delivery.mjs'
import { CredentialLogPoll } from './credential-log-poll.mjs'
import { deployment } from '../config/deployment.mjs'
import { gatewayToken } from './token-renewal.mjs'
import { notifySignups } from './signup-notices.mjs'
import { evaluateWorkHealth, workCodes, workLabels } from './work-health.mjs'
/**
 * @typedef {{ failures: number, successes: number, notified: boolean, lastAttempt: number }} AlertState
 */

/** @type {Record<string, string>} */
const labels = {
  gallery: 'Gallery availability',
  renewal: 'Snowflake token renewal',
  database: 'Database readiness',
  storage: 'Database storage usage',
  uploads: 'Upload failures',
  credentials: 'Password-change session revocation',
  ...workLabels,
}
/**
 * Delivery acknowledgement only; provider acceptance is not mailbox receipt.
 * @param {string} code
 * @param {string} action
 * @param {AlertDelivery | null | undefined} result
 */
export function alertDeliveryReceipt(code, action, result) {
  if (!Object.hasOwn(labels, code) || !['problem', 'recovery'].includes(action)) return
  try {
    console.info(
      JSON.stringify({
        event: 'stillmark_alert_delivery',
        version: 1,
        check: code,
        action,
        accepted: result?.accepted === true,
      }),
    )
  } catch {
    // Telemetry must not change incident state or cause duplicate email delivery.
  }
}
/** @param {Env} env */
export function storageWarningBytes(env) {
  const raw = env.PG_STORAGE_WARNING_BYTES
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) return null
  const bytes = Number(raw)
  return Number.isSafeInteger(bytes) ? bytes : null
}
/** @param {Env} env */
export function storageWarningMessage(env) {
  const bytes = storageWarningBytes(env)
  if (bytes === null)
    return 'Database-size monitoring configuration is invalid. Set PG_STORAGE_WARNING_BYTES to a positive integer byte count. Storage usage cannot be evaluated until this is corrected.'
  return `Database size reached the configured ${bytes / 1_000_000_000} GB (${bytes} bytes) warning threshold. This measures database size only, excluding WAL and other disk overhead; it is not physical-disk utilization.`
}
/**
 * @param {Partial<AlertState> | null | undefined} previous
 * @param {boolean} healthy
 */
export function transition(previous, healthy) {
  const s = { failures: 0, successes: 0, notified: false, lastAttempt: 0, ...previous }
  if (healthy) {
    s.failures = 0
    s.successes++
  } else {
    s.successes = 0
    s.failures++
  }
  const action =
    !healthy && s.failures >= 3 && !s.notified
      ? 'problem'
      : healthy && s.successes >= 2 && s.notified
        ? 'recovery'
        : null
  return { state: s, action }
}
export class EmailAlerts {
  /**
   * @param {DurableObjectState} ctx
   * @param {Env} env
   */
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
    /** @type {Promise<Record<string, boolean>> | null} */
    this.running = null
    this.credentials = new CredentialOutbox(ctx, env)
    this.credentialLogs = new CredentialLogPoll(ctx, env, (event) =>
      this.credentials.enqueue(event),
    )
  }
  async alarm() {
    await this.credentials.alarm()
  }
  /** @param {Request} request */
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/credential-enqueue' && request.method === 'POST') {
      try {
        return await this.credentials.enqueue(await request.json())
      } catch {
        return new Response('Recovery unavailable', { status: 503 })
      }
    }
    if (path === '/credential-status') return Response.json(await this.credentials.status())
    if (path === '/credential-poll' && request.method === 'POST')
      return Response.json(await this.credentialLogs.poll())
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/check')
      return new Response('Not found', { status: 404 })
    if (!this.running)
      this.running = this.check().finally(() => {
        this.running = null
      })
    return Response.json(await this.running)
  }
  /**
   * @param {string} subject
   * @param {string} body
   */
  async deliver(subject, body) {
    const { connect } = await import('cloudflare:sockets')
    const { sendAlertEmail } = await import('./smtp.mjs')
    return sendAlertEmail(this.env, connect, subject, body)
  }
  /** @returns {Promise<Record<string, boolean>>} */
  async check() {
    const now = Date.now()
    if (now - /** @type {number} */ ((await this.ctx.storage.get('lastCheck')) ?? 0) < 240000)
      return { skipped: true }
    await this.ctx.storage.put('lastCheck', now)
    let gallery = false
    let renewal = false
    /** @type {Record<string, boolean>} */
    const checks = {}
    /** @type {unknown} */
    let signups
    /** @type {Record<string, string>} */
    let workDetails = {}
    try {
      const token = await gatewayToken(this.env)
      // An unset origin or signing key throws and is recorded as a failed check.
      const url = new URL(/** @type {string} */ (this.env.SNOWFLAKE_ORIGIN))
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.snowflakecomputing.app'))
        throw Error('Origin')
      url.pathname = '/api/health/live'
      const r = await fetch(url, {
        headers: { Authorization: `Snowflake Token="${token}"` },
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      })
      gallery = r.ok && (await r.json()).status === 'ok'
      if (gallery) {
        const stamp = String(now)
        const key = await crypto.subtle.importKey(
          'raw',
          Uint8Array.from(
            /** @type {string[]} */ (
              /** @type {string} */ (this.env.GATEWAY_SIGNING_KEY).match(/../g)
            ),
            (x) => parseInt(x, 16),
          ),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        )
        const signature = Array.from(
          new Uint8Array(
            await crypto.subtle.sign(
              'HMAC',
              key,
              new TextEncoder().encode('photo-monitor-v1:' + stamp),
            ),
          ),
          (b) => b.toString(16).padStart(2, '0'),
        ).join('')
        url.pathname = '/api/health/monitor'
        checks.database = false
        const m = await fetch(url, {
          headers: {
            Authorization: `Snowflake Token="${token}"`,
            'x-photo-monitor-time': stamp,
            'x-photo-monitor-signature': signature,
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(15000),
        })
        const data = await m.json()
        checks.database = m.ok && data.database === true
        if (checks.database) {
          signups = data.recentSignups
          const storageThreshold = storageWarningBytes(this.env)
          checks.storage =
            storageThreshold !== null &&
            Number.isSafeInteger(data.databaseBytes) &&
            data.databaseBytes >= 0 &&
            data.databaseBytes < storageThreshold
          checks.uploads =
            Number.isFinite(data.failedUploadsLastHour) && data.failedUploadsLastHour < 3
          // Stalled work fails nothing, so it is judged separately from failures.
          const work = evaluateWorkHealth(data.workHealth)
          Object.assign(checks, work.checks)
          workDetails = work.details
        }
      }
    } catch {}
    try {
      const stub = this.env.GATEWAY_TOKENS.get(this.env.GATEWAY_TOKENS.idFromName('gateway'))
      const r = await stub.fetch('https://internal/status')
      const status = await r.json()
      renewal = r.ok && status.expiresAt > now + 3 * 86400000
    } catch {}
    if (this.env.CUSTOMER_ACCOUNTS_ENABLED === 'true' && this.env.EMAIL_ALERTS) {
      checks.credentials = false
      try {
        const recovery = await credentialQueue(this.env).fetch('https://internal/credential-poll', {
          method: 'POST',
        })
        const recovered = await recovery.json()
        const status = await credentialQueue(this.env).fetch('https://internal/credential-status')
        const value = await status.json()
        checks.credentials =
          status.ok &&
          Number.isInteger(value.pending) &&
          Number.isFinite(value.oldestAgeMs) &&
          value.oldestAgeMs < 60000 &&
          (this.env.AUTH0_LOG_POLL_ENABLED !== 'true' ||
            (recovery.ok && recovered.healthy === true))
      } catch {}
    }
    for (const code of ['database', 'storage', 'uploads', ...workCodes])
      if (!(code in checks)) {
        /** @type {AlertState | undefined} */
        const previous = await this.ctx.storage.get(code)
        if (previous) await this.ctx.storage.put(code, { ...previous, failures: 0, successes: 0 })
      }
    for (const [code, healthy] of Object.entries({ gallery, renewal, ...checks })) {
      const { state, action } = transition(
        /** @type {AlertState | undefined} */ (await this.ctx.storage.get(code)),
        healthy,
      )
      if (action && now - state.lastAttempt >= 3600000) {
        state.lastAttempt = now
        await this.ctx.storage.put(code, state)
        const result = await this.deliver(
          `${action === 'recovery' ? 'Recovered' : 'Needs attention'}: ${labels[code]}`,
          `${labels[code]} ${action === 'recovery' ? 'has recovered after two successful checks.' : 'needs attention after three failed checks.'}\n\n${action === 'recovery' ? 'The monitored condition is back below its warning threshold; review any previously failed work separately.' : code in workDetails ? workDetails[code] : code === 'credentials' ? 'Password-change recovery needs attention. Inspect the durable retry queue and Auth0 log polling health, including any log-retention coverage warning. Queued events are retained until the application acknowledges persistence.' : code === 'renewal' ? 'The gateway credential is unavailable or expires within three days. Check automatic renewal.' : code === 'storage' ? storageWarningMessage(this.env) : code === 'uploads' ? 'At least three upload failures were recorded in the past hour. Review Admin Activity.' : code === 'database' ? 'The protected database check failed or could not respond.' : 'The gateway could not confirm that the gallery server is responding.'}\n\nOpen ${deployment.GATEWAY_ORIGIN}/ to review the app.\nThis automated check runs every five minutes.`,
        )
        alertDeliveryReceipt(code, action, result)
        if (result.accepted) {
          state.notified = action === 'problem'
          state.lastAttempt = 0
        } else console.error('email_alert_delivery_failed', code, result.stage, result.error)
      }
      await this.ctx.storage.put(code, state)
    }
    // New-account notices are independent of incident state and never affect it.
    if (this.env.CUSTOMER_ACCOUNTS_ENABLED === 'true') {
      try {
        await notifySignups(this.ctx.storage, signups, now, deployment.GATEWAY_ORIGIN, (s, b) =>
          this.deliver(s, b),
        )
      } catch {
        console.error('signup_notice_failed')
      }
    }
    return { checked: true, gallery, renewal, ...checks }
  }
}
/** @param {Env} env */
export async function checkAlerts(env) {
  const r = await env.EMAIL_ALERTS.get(env.EMAIL_ALERTS.idFromName('operations')).fetch(
    'https://internal/check',
    { method: 'POST' },
  )
  if (!r.ok) throw Error('Alert check failed')
  return r.json()
}
