import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHmac, randomUUID } from 'node:crypto'

const state = vi.hoisted(() => ({ name: 'TEST_USER_0', epoch: '1', read: vi.fn() }))
vi.mock('../lib/snowflake', () => ({
  getSecret: () => 'ab'.repeat(32),
  SecretType: { GENERIC_STRING: 'GENERIC_STRING' },
}))
vi.mock('../lib/postgres', () => ({
  pgAuthGateway: async () => ({ name: state.name, epoch: state.epoch }),
}))
vi.mock('../lib/identity/identity-control', () => ({ identityControl: state.read }))
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(100000)
  vi.stubEnv('GATEWAY_ROLE_CACHE_MAX_ENTRIES', undefined)
  vi.stubEnv('GATEWAY_AUTH_ENABLED', 'true')
  vi.stubEnv('GATEWAY_ORIGIN', 'https://photos.stillmark.example')
  state.epoch = '1'
  state.read
    .mockReset()
    .mockImplementation(async (action: string, payload: { name: string }) =>
      action === 'findUser'
        ? [{ name: payload.name, disabled: false }]
        : action === 'userGrants'
          ? [{ role: 'PERSONAL_PHOTOS_VIEWER', granted_on: 'ROLE', privilege: 'USAGE' }]
          : [],
    )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
function request() {
  const body = Buffer.from(
    JSON.stringify({
      jti: randomUUID(),
      method: 'GET',
      target: '/api/events',
      sub: 'auth0|' + state.name,
      sid: '12345678-1234-1234-1234-123456789012',
      aud: 'https://photos.stillmark.example',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30,
    }),
  ).toString('base64url')
  return new Headers({
    'x-photo-request-method': 'GET',
    'x-photo-request-target': '/api/events',
    'sf-context-current-user': 'PERSONAL_PHOTOS_GATEWAY',
    'x-photo-gateway-identity':
      body +
      '.' +
      createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex'))
        .update(body)
        .digest('base64url'),
  })
}
it('retains more than 500 live identities and invalidates a changed epoch', async () => {
  const { gatewayIdentity } = await import('../lib/identity/gateway-auth')
  for (let i = 0; i < 510; i++) {
    state.name = 'TEST_USER_' + i
    await gatewayIdentity(request())
  }
  state.read.mockClear()
  state.name = 'TEST_USER_0'
  await gatewayIdentity(request())
  expect(state.read).not.toHaveBeenCalled()
  state.epoch = '2'
  await gatewayIdentity(request())
  expect(state.read).toHaveBeenCalledTimes(2)
})
it('uses bounded recency eviction without extending identity expiry', async () => {
  vi.stubEnv('GATEWAY_ROLE_CACHE_MAX_ENTRIES', '2')
  const { gatewayIdentity } = await import('../lib/identity/gateway-auth')
  for (const i of [0, 1, 0, 2, 0]) {
    state.name = 'TEST_USER_' + i
    await gatewayIdentity(request())
  }
  expect(state.read.mock.calls.filter((c) => c[0] === 'findUser')).toHaveLength(3)
  state.name = 'TEST_USER_1'
  await gatewayIdentity(request())
  // Identity eviction can reuse a still-fresh independently bounded user snapshot.
  expect(state.read.mock.calls.filter((c) => c[0] === 'findUser')).toHaveLength(3)
  vi.advanceTimersByTime(15001)
  await gatewayIdentity(request())
  expect(state.read.mock.calls.filter((c) => c[0] === 'findUser')).toHaveLength(4)
})
