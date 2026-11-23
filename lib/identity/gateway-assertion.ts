import { createHmac, timingSafeEqual } from 'node:crypto'
import { HttpError } from '../http'

export type GatewayAssertion = {
  startedAt?: number
  onboarding?: { issuer: string; email: string; displayName: string; verified: boolean }
  credentialChange?: number
  sub: string
  sid: string
  iat: number
  exp: number
  aud: string
  jti: string
  method: string
  target: string
}
/** A short-lived, server-to-server assertion. Never accept role or username claims. */
export function verifyGatewayAssertion(
  token: string,
  key: string,
  audience: string,
  now = Date.now() / 1000,
): GatewayAssertion {
  if (!/^[a-f0-9]{64}$/.test(key) || token.length > 4096)
    throw new HttpError(401, 'Invalid gateway identity', undefined, 'GATEWAY_AUTH_FAILED')
  const parts = token.split('.')
  if (parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)))
    throw new HttpError(401, 'Invalid gateway identity', undefined, 'GATEWAY_AUTH_FAILED')
  const expected = createHmac('sha256', Buffer.from(key, 'hex')).update(parts[0]).digest()
  const actual = Buffer.from(parts[1], 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new HttpError(401, 'Invalid gateway identity', undefined, 'GATEWAY_AUTH_FAILED')
  let value: GatewayAssertion
  try {
    value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
  } catch {
    throw new HttpError(401, 'Invalid gateway identity', undefined, 'GATEWAY_AUTH_FAILED')
  }
  if (
    !value ||
    (value.startedAt !== undefined &&
      (!Number.isInteger(value.startedAt) || value.startedAt > now + 5 || value.startedAt <= 0)) ||
    typeof value.jti !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.jti) ||
    !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(value.method) ||
    typeof value.target !== 'string' ||
    !value.target.startsWith('/') ||
    value.target.length > 8192 ||
    typeof value.sub !== 'string' ||
    !value.sub.startsWith('auth0|') ||
    value.sub.length > 200 ||
    typeof value.sid !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.sid) ||
    value.aud !== audience ||
    !Number.isInteger(value.iat) ||
    !Number.isInteger(value.exp) ||
    value.iat > now + 5 ||
    value.exp <= now ||
    value.exp - value.iat > 30 ||
    value.exp <= value.iat
  )
    throw new HttpError(401, 'Invalid gateway identity', undefined, 'GATEWAY_AUTH_FAILED')
  return value
}
