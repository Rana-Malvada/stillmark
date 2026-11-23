import { deliverCredential, validCredentialEvent } from './credential-delivery.mjs'

const MAX_PENDING = 1000
const RETRY_MAX_MS = 300000

/** @typedef {CredentialEvent & { attempts: number, firstSeen: number, nextAttempt: number }} PendingCredential */

/** @param {CredentialEvent} event */
async function subjectKey(event) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(event.issuer + '\n' + event.subject),
  )
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')
}
/** This uses the existing EmailAlerts Durable Object under a separate instance name. */
export class CredentialOutbox {
  /**
   * @param {DurableObjectState} ctx
   * @param {Env} env
   * @param {(event: CredentialEvent, env: Env) => Promise<void>} [deliver]
   */
  constructor(ctx, env, deliver = deliverCredential) {
    this.ctx = ctx
    this.env = env
    this.deliver = deliver
  }
  /** @param {any} event Untrusted until validated below. */
  async enqueue(event) {
    if (!validCredentialEvent(event, this.env))
      return Response.json({ error: 'Invalid event' }, { status: 400 })
    const id = await subjectKey(event)
    await this.ctx.storage.transaction(async (tx) => {
      // Nothing delivered yet reads as undefined, which compares false.
      const delivered = /** @type {number} */ (await tx.get('done:' + id))
      if (delivered >= event.changedAt) return
      const key = 'pending:' + id
      /** @type {PendingCredential | undefined} */
      const old = await tx.get(key)
      if (!old && (await tx.list({ prefix: 'pending:', limit: MAX_PENDING })).size >= MAX_PENDING)
        throw Error('Credential recovery capacity reached')
      if (!old || old.changedAt < event.changedAt)
        await tx.put(key, {
          ...event,
          attempts: 0,
          firstSeen: old?.firstSeen ?? Date.now(),
          nextAttempt: Date.now(),
        })
      const alarm = await tx.getAlarm()
      if (alarm === null || alarm > Date.now() + 1000) await tx.setAlarm(Date.now() + 1000)
    })
    return Response.json({ durable: true }, { status: 202 })
  }
  async status() {
    // The five-minute operations check also restores a missing alarm after a
    // prolonged storage/platform outage exhausts automatic alarm retries.
    const pending = await this.ctx.storage.transaction(async (tx) => {
      /** @type {Map<string, PendingCredential>} */
      const rows = await tx.list({ prefix: 'pending:', limit: MAX_PENDING })
      if (rows.size && (await tx.getAlarm()) === null) await tx.setAlarm(Date.now() + 1000)
      return rows
    })
    const oldest = Math.min(Date.now(), ...Array.from(pending.values(), (e) => e.firstSeen))
    return { pending: pending.size, oldestAgeMs: pending.size ? Date.now() - oldest : 0 }
  }
  async alarm() {
    /** @type {Map<string, PendingCredential>} */
    const entries = await this.ctx.storage.list({ prefix: 'pending:', limit: MAX_PENDING })
    const due = [...entries]
      .filter(([, event]) => event.nextAttempt <= Date.now())
      .sort((a, b) => a[1].nextAttempt - b[1].nextAttempt)
      .slice(0, 4)
    // Four bounded requests per alarm, in parallel. Failed events have no expiry.
    await Promise.all(
      due.map(async ([key, event]) => {
        let accepted = false
        try {
          await this.deliver(event, this.env)
          accepted = true
        } catch {
          /* Retain the original event. */
        }
        await this.ctx.storage.transaction(async (tx) => {
          /** @type {PendingCredential | undefined} */
          const current = await tx.get(key)
          if (accepted) {
            const doneKey = key.replace('pending:', 'done:')
            await tx.put(
              doneKey,
              Math.max(
                /** @type {number | undefined} */ (await tx.get(doneKey)) ?? 0,
                event.changedAt,
              ),
            )
            if (current?.changedAt === event.changedAt) await tx.delete(key)
          } else if (current?.changedAt === event.changedAt) {
            const attempts = current.attempts + 1
            await tx.put(key, {
              ...current,
              attempts,
              nextAttempt: Date.now() + Math.min(RETRY_MAX_MS, 1000 * 2 ** Math.min(attempts, 9)),
            })
          }
        })
      }),
    )
    await this.ctx.storage.transaction(async (tx) => {
      /** @type {Map<string, PendingCredential>} */
      const remaining = await tx.list({ prefix: 'pending:', limit: MAX_PENDING })
      if (remaining.size)
        await tx.setAlarm(
          Math.max(
            Date.now() + 1000,
            Math.min(...Array.from(remaining.values(), (e) => e.nextAttempt)),
          ),
        )
    })
  }
}
