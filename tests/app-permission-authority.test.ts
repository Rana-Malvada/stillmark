import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHmac, randomUUID } from 'node:crypto'

const state = vi.hoisted(() => ({
  read: vi.fn(),
  query: vi.fn(),
  headers: new Headers(),
  row: {} as any,
}))
vi.mock('../lib/postgres', () => ({ pgAuthGateway: state.read, pgAuthEpoch: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => state.headers }))
vi.mock('../lib/snowflake', () => ({
  getServiceToken: () => 'service-token',
  getSecret: () => 'ab'.repeat(32),
  SecretType: { GENERIC_STRING: 'GENERIC_STRING' },
  querySnowflake: state.query,
}))
vi.mock('../lib/identity/identity-control', () => ({ identityControl: state.query }))
beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('APP_PERMISSION_AUTHORITY', 'postgres')
  vi.stubEnv('GATEWAY_AUTH_ENABLED', 'true')
  vi.stubEnv('GATEWAY_ORIGIN', 'https://photos.stillmark.example')
  state.row = {
    name: 'ALICE',
    marker: randomUUID(),
    epoch: '1',
    revoked: false,
    enabled: true,
    app_role: 'viewer',
    app_owner: false,
    can_manage_personal: true,
    can_manage_access: false,
    main_admin: false,
  }
  state.read.mockReset().mockImplementation(async () => state.row)
  state.query.mockReset()
  const body = Buffer.from(
    JSON.stringify({
      jti: randomUUID(),
      method: 'GET',
      target: '/api/events',
      sub: 'auth0|alice',
      sid: randomUUID(),
      aud: 'https://photos.stillmark.example',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30,
    }),
  ).toString('base64url')
  state.headers = new Headers({
    'x-photo-request-method': 'GET',
    'x-photo-request-target': '/api/events',
    'sf-context-current-user': 'PERSONAL_PHOTOS_GATEWAY',
    'sf-context-current-user-token': 'transport-token',
    'x-photo-gateway-identity':
      body +
      '.' +
      createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex'))
        .update(body)
        .digest('base64url'),
  })
})
afterEach(() => vi.unstubAllEnvs())
it('uses only Postgres permissions, including privileged checks', async () => {
  const { gatewayIdentity } = await import('../lib/identity/gateway-auth')
  expect(await gatewayIdentity(state.headers)).toMatchObject({
    username: 'ALICE',
    role: 'viewer',
    canManageAccess: false,
  })
  state.row = {
    ...state.row,
    epoch: '2',
    app_role: 'admin',
    app_owner: true,
    can_manage_access: true,
  }
  expect(await gatewayIdentity(state.headers, true)).toMatchObject({
    role: 'admin',
    appOwner: true,
    canManageAccess: true,
  })
  expect(state.query).not.toHaveBeenCalled()
})
it('observes removals, disable and logout without a cross-request role cache', async () => {
  const { gatewayIdentity } = await import('../lib/identity/gateway-auth')
  await gatewayIdentity(state.headers)
  state.row = { ...state.row, app_role: null }
  await expect(gatewayIdentity(state.headers)).rejects.toMatchObject({ status: 403 })
  state.row = { ...state.row, app_role: 'viewer', enabled: false }
  await expect(gatewayIdentity(state.headers)).rejects.toMatchObject({ status: 403 })
  state.row = { ...state.row, enabled: true, revoked: true }
  await expect(gatewayIdentity(state.headers)).rejects.toMatchObject({ status: 401 })
  expect(state.query).not.toHaveBeenCalled()
})
it('fails closed on missing authority rows or database failures, never falling back to Snowflake', async () => {
  const { gatewayIdentity } = await import('../lib/identity/gateway-auth')
  state.row = { ...state.row, enabled: null, app_role: null }
  await expect(gatewayIdentity(state.headers)).rejects.toMatchObject({ status: 403 })
  state.read.mockRejectedValue(Error('database unavailable'))
  await expect(gatewayIdentity(state.headers)).rejects.toThrow('database unavailable')
  expect(state.query).not.toHaveBeenCalled()
})
it('rejects native Snowflake end-user ingress in app-owned mode', async () => {
  state.headers = new Headers({
    'sf-context-current-user': 'ALICE',
    'sf-context-current-user-token': 'legacy-token',
  })
  const { requireAuth } = await import('../lib/identity/auth')
  await expect(requireAuth()).rejects.toMatchObject({ status: 401 })
  expect(state.query).not.toHaveBeenCalled()
})
it('rejects an unknown authority configuration', async () => {
  vi.stubEnv('APP_PERMISSION_AUTHORITY', 'typo')
  const { postgresPermissionsEnabled } = await import('../lib/permission-authority')
  expect(() => postgresPermissionsEnabled()).toThrow('Invalid APP_PERMISSION_AUTHORITY')
})
