import { REMEMBERED_SESSION_SECONDS } from './session-policy.mjs'
/** One private Durable Object per random session ID. No identity or credentials stored. */
export class RevokedSession {
  /** @param {DurableObjectState} ctx */
  constructor(ctx) {
    this.ctx = ctx
  }
  /** @param {Request} request */
  async fetch(request) {
    if (request.method === 'POST') {
      // Cover the entire 30-day remembered login lifetime, including every renewed cookie.
      await this.ctx.storage.put('revoked', true)
      await this.ctx.storage.setAlarm(Date.now() + (REMEMBERED_SESSION_SECONDS + 300) * 1000)
      return new Response(null, { status: 204 })
    }
    if (request.method === 'GET')
      return Response.json({ revoked: (await this.ctx.storage.get('revoked')) === true })
    return new Response(null, { status: 405 })
  }
  async alarm() {
    await this.ctx.storage.deleteAll()
  }
}
/**
 * @param {Env} env
 * @param {string} sid
 */
function stub(env, sid) {
  if (!env.REVOKED_SESSIONS || typeof sid !== 'string' || !/^[a-f0-9-]{36}$/i.test(sid))
    throw Error('Invalid session')
  return env.REVOKED_SESSIONS.get(env.REVOKED_SESSIONS.idFromName(sid))
}
/**
 * @param {Env} env
 * @param {string} sid
 */
export async function isRevoked(env, sid) {
  const r = await stub(env, sid).fetch('https://session/check')
  if (!r.ok) throw Error('Session check unavailable')
  return (await r.json()).revoked !== false
}
/**
 * @param {Env} env
 * @param {string} sid
 */
export async function revokeSession(env, sid) {
  const r = await stub(env, sid).fetch('https://session/revoke', { method: 'POST' })
  if (!r.ok) throw Error('Session revocation unavailable')
}
