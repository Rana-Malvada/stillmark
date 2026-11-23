import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyGatewayAssertion } from '../lib/identity/gateway-assertion'

const key = 'ab'.repeat(32)
const aud = 'https://photos.stillmark.example'
const good = {
  jti: '12345678-1234-1234-1234-123456789012',
  method: 'GET',
  target: '/api/events',
  sub: 'auth0|test',
  sid: '12345678-1234-1234-1234-123456789012',
  aud,
  iat: 1000,
  exp: 1030,
}
function sign(value: unknown, secret = key) {
  const p = Buffer.from(JSON.stringify(value)).toString('base64url')
  return p + '.' + createHmac('sha256', Buffer.from(secret, 'hex')).update(p).digest('base64url')
}
describe('gateway identity boundary', () => {
  it('accepts a valid short-lived assertion', () =>
    expect(verifyGatewayAssertion(sign(good), key, aud, 1001).sub).toBe('auth0|test'))
  it.each([
    { ...good, jti: undefined },
    { ...good, method: 'TRACE' },
    { ...good, target: 'https://evil.example' },
    { ...good, exp: 999 },
    { ...good, iat: 1010 },
    { ...good, exp: 5000 },
    { ...good, aud: 'other' },
    { ...good, sub: 'ACCOUNTADMIN' },
    { ...good, sid: '' },
    null,
    {},
    { ...good, iat: '1000' },
  ])('rejects invalid claims %#', (value) =>
    expect(() => verifyGatewayAssertion(sign(value), key, aud, 1001)).toThrow(),
  )
  it('rejects forgery and tampering', () => {
    expect(() => verifyGatewayAssertion(sign(good, 'cd'.repeat(32)), key, aud, 1001)).toThrow()
    expect(() => verifyGatewayAssertion(sign(good) + '.extra', key, aud, 1001)).toThrow()
    expect(() => verifyGatewayAssertion('not.a-signature', key, aud, 1001)).toThrow()
  })
})
