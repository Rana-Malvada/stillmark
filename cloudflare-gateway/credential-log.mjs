import { credentialReceipt } from './credential-receipt.mjs'
import { retainCredential } from './credential-delivery.mjs'
import { passwordChangeFromLog } from './credential-log-event.mjs'

const MAX_LOG_BYTES = 262144
/**
 * @param {Request} request
 * @param {Env} env
 */
export async function credentialLog(request, env) {
  if (new URL(request.url).pathname !== '/auth/credential-log') return null
  const headers = { 'Cache-Control': 'no-store' }
  if (request.method !== 'POST' || env.CUSTOMER_ACCOUNTS_ENABLED !== 'true')
    return new Response('Not found', { status: 404, headers })
  if (!/^[a-f0-9]{64}$/.test(env.AUTH0_LOG_STREAM_TOKEN ?? ''))
    return new Response('Unavailable', { status: 503, headers })
  const supplied = new TextEncoder().encode(request.headers.get('authorization') ?? '')
  const expected = new TextEncoder().encode('Bearer ' + env.AUTH0_LOG_STREAM_TOKEN)
  let different = supplied.length ^ expected.length
  for (let i = 0; i < expected.length; i++) different |= (supplied[i] ?? 0) ^ expected[i]
  if (different) return new Response('Unauthorized', { status: 401, headers })
  let records
  try {
    const reader = request.body?.getReader()
    if (!reader) throw Error('Missing body')
    const parts = []
    let bytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.length
        if (bytes > MAX_LOG_BYTES) {
          await reader.cancel()
          throw Error('Oversize log batch')
        }
        parts.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const part of parts) {
      body.set(part, offset)
      offset += part.length
    }
    const text = new TextDecoder().decode(body)
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    }
    records = Array.isArray(parsed) ? parsed : [parsed]
    if (!records.length || records.length > 1000) throw Error('Invalid batch')
    // Validate the full batch before acknowledging any record. scpr means reset
    // requested, not changed, and must never revoke an account's sessions.
    records = /** @type {CredentialEvent[]} */ (
      records
        .map((row) => row?.data ?? row)
        .map((row) => passwordChangeFromLog(row, env))
        .filter(Boolean)
    )
  } catch {
    return new Response('Invalid log batch', { status: 400, headers })
  }
  try {
    for (const event of records) {
      await retainCredential(event, env)
      await credentialReceipt(event, env, 'log-stream', 'durable')
    }
    return Response.json({ accepted: true }, { status: 202, headers })
  } catch {
    return new Response('Retry log batch', { status: 503, headers })
  }
}
