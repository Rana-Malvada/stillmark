import { proxyGallery } from './proxy.mjs'
import { gatewayToken } from './token-renewal.mjs'

/**
 * @param {any} event Parsed, untrusted request or storage data.
 * @param {Env} env
 */
export function validCredentialEvent(event, env) {
  return (
    event &&
    event.issuer === `https://${env.AUTH0_DOMAIN}/` &&
    typeof event.subject === 'string' &&
    event.subject.startsWith('auth0|') &&
    event.subject.length <= 200 &&
    Number.isSafeInteger(event.changedAt) &&
    event.changedAt > 0 &&
    event.changedAt <= Math.floor(Date.now() / 1000) + 5
  )
}
/**
 * @param {CredentialEvent} event
 * @param {Env} env
 * @param {number} [timeoutMs]
 */
export async function deliverCredential(event, env, timeoutMs = 15000) {
  const controller = new AbortController()
  const signal = controller.signal
  let timer
  try {
    await Promise.race([
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(Error('Credential delivery timed out'))
        }, timeoutMs)
      }),
      (async () => {
        const upstream = await proxyGallery(
          new Request(env.GATEWAY_ORIGIN + '/api/account/credential-change', {
            method: 'POST',
            headers: { origin: env.GATEWAY_ORIGIN },
            signal,
          }),
          { ...env, SNOWFLAKE_PAT: await gatewayToken(env) },
          {
            auth0Subject: event.subject,
            sid: crypto.randomUUID(),
            startedAt: Math.floor(Date.now() / 1000),
            credentialChange: event.changedAt,
          },
        )
        if (!upstream.ok) throw Error('Credential persistence unavailable')
        const body = await upstream.json()
        if (body?.ok !== true) throw Error('Credential persistence not acknowledged')
      })(),
    ])
  } finally {
    clearTimeout(timer)
  }
}
/** @param {Env} env */
export function credentialQueue(env) {
  if (!env.EMAIL_ALERTS) throw Error('Credential recovery unavailable')
  return env.EMAIL_ALERTS.get(env.EMAIL_ALERTS.idFromName('credential-events'))
}
/**
 * @param {CredentialEvent} event
 * @param {Env} env
 */
export async function retainCredential(event, env) {
  const response = await credentialQueue(env).fetch('https://internal/credential-enqueue', {
    method: 'POST',
    body: JSON.stringify(event),
    headers: { 'Content-Type': 'application/json' },
  })
  if (!response.ok || (await response.json())?.durable !== true)
    throw Error('Credential recovery not acknowledged')
}
