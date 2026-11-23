import { legacyIdentityCommand } from './identity-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHmac, randomUUID } from 'node:crypto'

const state = vi.hoisted(() => ({ query: vi.fn(), pg: vi.fn() }))
vi.mock('../lib/snowflake', () => ({
  querySnowflake: state.query,
  getSecret: () => 'ab'.repeat(32),
  SecretType: { GENERIC_STRING: 'GENERIC_STRING' },
}))
vi.mock('../lib/postgres', () => ({ pgAuthGateway: state.pg }))
import {
  gatewayAssertion,
  gatewayIdentity,
  resolveGatewayRoles,
} from '../lib/identity/gateway-auth'

beforeEach(() => {
  state.query.mockReset()
  state.pg.mockReset()
  vi.stubEnv('GATEWAY_AUTH_ENABLED', 'true')
  vi.stubEnv('GATEWAY_ORIGIN', 'https://photos.stillmark.example')
})
afterEach(() => vi.unstubAllEnvs())
function transport(user = 'PERSONAL_PHOTOS_GATEWAY', target = '/api/events') {
  const now = Math.floor(Date.now() / 1000)
  const value = {
    jti: randomUUID(),
    method: 'GET',
    target,
    sub: 'auth0|linked',
    sid: '12345678-1234-1234-1234-123456789012',
    aud: 'https://photos.stillmark.example',
    iat: now,
    exp: now + 30,
  }
  const body = Buffer.from(JSON.stringify(value)).toString('base64url')
  return new Headers({
    'x-photo-request-method': 'GET',
    'x-photo-request-target': target,
    'sf-context-current-user': user,
    'x-photo-gateway-identity':
      body +
      '.' +
      createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex'))
        .update(body)
        .digest('base64url'),
  })
}
function grants(roles: string[], disabled = false) {
  state.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SHOW USERS')) return [{ name: 'ES', disabled }]
    if (sql.startsWith('SHOW GRANTS TO USER'))
      return roles.map((role) => ({ role, granted_on: 'ROLE', privilege: 'USAGE' }))
    return []
  })
}
it('rejects spoofed transport users even with a signed assertion', async () => {
  await expect(gatewayIdentity(transport('OTHER_USER'))).rejects.toMatchObject({ status: 401 })
  expect(state.pg).not.toHaveBeenCalled()
})
it('requires a signed identity for the service user', async () => {
  await expect(
    gatewayIdentity(new Headers({ 'sf-context-current-user': 'PERSONAL_PHOTOS_GATEWAY' })),
  ).rejects.toMatchObject({ status: 401 })
})
it('rejects an unlinked identity and disabled integration', async () => {
  state.pg.mockResolvedValue(null)
  await expect(gatewayIdentity(transport())).rejects.toMatchObject({ status: 401 })
  vi.stubEnv('GATEWAY_AUTH_ENABLED', 'false')
  await expect(gatewayIdentity(transport())).rejects.toMatchObject({ status: 401 })
})
it('retains the mapped individual username', async () => {
  state.pg.mockResolvedValue({ name: 'ES' })
  grants(['PERSONAL_PHOTOS_VIEWER'])
  await expect(gatewayIdentity(transport())).resolves.toMatchObject({
    username: 'ES',
    role: 'viewer',
    canManageAccess: false,
  })
  expect(state.pg.mock.calls[0]).toEqual([
    'auth0|linked',
    '12345678-1234-1234-1234-123456789012',
    expect.any(String),
    expect.any(Number),
  ])
})
it('read-only admins cannot manage photos or users, and viewer permissions remain inclusive', async () => {
  grants(['PERSONAL_PHOTOS_ADMIN_READONLY'])
  await expect(resolveGatewayRoles('ES')).resolves.toMatchObject({
    role: 'admin_readonly',
    canManagePersonal: false,
    canManageAccess: false,
  })
  grants(['PERSONAL_PHOTOS_ADMIN_READONLY', 'PERSONAL_PHOTOS_VIEWER'])
  await expect(resolveGatewayRoles('ES')).resolves.toMatchObject({
    role: 'admin_readonly',
    canManagePersonal: true,
    canManageAccess: false,
  })
})
it('app owners retain full gallery access without granting it to ordinary admins', async () => {
  grants(['PERSONAL_PHOTOS_APP_OWNER'])
  await expect(resolveGatewayRoles('ES')).resolves.toMatchObject({
    role: 'admin',
    appOwner: true,
    canManageAccess: true,
  })
  grants(['PERSONAL_PHOTOS_ADMIN'])
  await expect(resolveGatewayRoles('ES')).resolves.toMatchObject({
    role: 'admin',
    appOwner: false,
    canManageAccess: false,
  })
})
it('disabled users, revoked gallery grants and injected identifiers fail closed', async () => {
  grants(['PERSONAL_PHOTOS_VIEWER'], true)
  await expect(resolveGatewayRoles('ES')).rejects.toMatchObject({ status: 403 })
  grants([])
  await expect(resolveGatewayRoles('ES')).rejects.toMatchObject({ status: 403 })
  await expect(resolveGatewayRoles('ES"; DROP USER ES')).rejects.toMatchObject({ status: 403 })
})
it('inherits gallery roles through a custom role, with cycle protection', async () => {
  state.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SHOW USERS')) return [{ name: 'ES', disabled: false }]
    if (sql.startsWith('SHOW GRANTS TO USER'))
      return [{ role: 'PERSONAL_PHOTOS_GROUP_TEST', granted_on: 'ROLE', privilege: 'USAGE' }]
    if (sql.includes('"PERSONAL_PHOTOS_GROUP_TEST"'))
      return [
        { granted_on: 'ROLE', privilege: 'USAGE', name: 'PERSONAL_PHOTOS_VIEWER' },
        { granted_on: 'ROLE', privilege: 'USAGE', name: 'PERSONAL_PHOTOS_GROUP_TEST' },
      ]
    return []
  })
  await expect(resolveGatewayRoles('ES')).resolves.toMatchObject({ role: 'viewer' })
  expect(state.query).toHaveBeenCalledTimes(4)
})

it('ignores direct personal database and schema grants when resolving gallery roles', async () => {
  state.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SHOW USERS')) return [{ name: 'MEMBERONE', disabled: false }]
    if (sql.startsWith('SHOW GRANTS TO USER'))
      return [
        { granted_on: 'DATABASE', privilege: 'USAGE', name: 'USER$MEMBERONE', role: null },
        { granted_on: 'DATABASE', privilege: 'CREATE SCHEMA', name: 'USER$MEMBERONE', role: null },
        { granted_on: 'SCHEMA', privilege: 'OWNERSHIP', name: 'USER$MEMBERONE.LOCAL', role: null },
        {
          granted_on: 'ROLE',
          privilege: 'USAGE',
          name: 'PERSONAL_PHOTOS_VIEWER',
          role: 'PERSONAL_PHOTOS_VIEWER',
        },
      ]
    return []
  })
  await expect(resolveGatewayRoles('MEMBERONE')).resolves.toMatchObject({
    username: 'MEMBERONE',
    role: 'viewer',
    canManageAccess: false,
  })
  expect(state.query).toHaveBeenCalledTimes(3)
  expect(state.query).toHaveBeenLastCalledWith('SHOW GRANTS TO ROLE "PERSONAL_PHOTOS_VIEWER"')
})

it('registry removal blocks an already cached signed-in user immediately', async () => {
  state.pg.mockResolvedValue({ name: 'ES', marker: undefined })
  grants(['PERSONAL_PHOTOS_VIEWER'])
  await expect(gatewayIdentity(transport())).resolves.toMatchObject({ username: 'ES' })
  state.pg.mockResolvedValue(null)
  await expect(gatewayIdentity(transport())).rejects.toMatchObject({ status: 401 })
})
it('a Snowflake disable invalidates cached sessions after the bounded 15-second window', async () => {
  vi.useFakeTimers()
  try {
    state.pg.mockResolvedValue({ name: 'ES', marker: undefined })
    grants(['PERSONAL_PHOTOS_VIEWER'])
    await expect(gatewayIdentity(transport())).resolves.toMatchObject({ username: 'ES' })
    grants(['PERSONAL_PHOTOS_VIEWER'], true)
    vi.advanceTimersByTime(16000)
    await expect(gatewayIdentity(transport())).rejects.toMatchObject({ status: 403 })
  } finally {
    vi.useRealTimers()
  }
})

it('revocation blocks a cached role immediately without an extra database round trip', async () => {
  state.pg.mockResolvedValue({ name: 'ES', epoch: 'revocation-test', revoked: false })
  grants(['PERSONAL_PHOTOS_VIEWER'])
  await expect(gatewayIdentity(transport())).resolves.toMatchObject({ username: 'ES' })
  state.pg.mockClear()
  state.pg.mockResolvedValue({ name: 'ES', revoked: true })
  await expect(gatewayIdentity(transport())).rejects.toMatchObject({ status: 401 })
  expect(state.pg).toHaveBeenCalledTimes(1)
  expect(state.pg.mock.calls[0][0]).toBe('auth0|linked')
})

vi.mock('../lib/identity/identity-control', () => ({
  identityControl: (action: string, p: any) => state.query(legacyIdentityCommand(action, p)),
}))

it('rejects cross-method and cross-target replay before reaching PostgreSQL', async () => {
  const h = transport()
  h.set('x-photo-request-method', 'POST')
  await expect(gatewayIdentity(h)).rejects.toMatchObject({ status: 401 })
  h.set('x-photo-request-method', 'GET')
  h.set('x-photo-request-target', '/api/admin/access')
  await expect(gatewayIdentity(h)).rejects.toMatchObject({ status: 401 })
  expect(state.pg).not.toHaveBeenCalled()
})
it('consumes a signature only once within a request, but again on a new request', async () => {
  const { withDatabaseRequest } = await import('../lib/database/database-context')
  grants(['PERSONAL_PHOTOS_VIEWER'])
  state.pg.mockResolvedValue({ name: 'ES', epoch: 'coalesce' })
  const h = transport()
  await withDatabaseRequest(async () => {
    await gatewayIdentity(h)
    await gatewayIdentity(h, true)
  })()
  expect(state.pg).toHaveBeenCalledTimes(1)
  state.pg.mockResolvedValue(undefined)
  await expect(withDatabaseRequest(() => gatewayIdentity(h))()).rejects.toMatchObject({
    status: 401,
  })
})
it('a changed shared epoch invalidates roles and mutations bypass read caches', async () => {
  state.pg.mockResolvedValue({ name: 'ES', epoch: 'before' })
  grants(['PERSONAL_PHOTOS_ADMIN'])
  expect((await gatewayIdentity(transport()))?.role).toBe('admin')
  grants(['PERSONAL_PHOTOS_VIEWER'])
  state.pg.mockResolvedValue({ name: 'ES', epoch: 'after' })
  expect((await gatewayIdentity(transport()))?.role).toBe('viewer')
  grants(['PERSONAL_PHOTOS_ADMIN'])
  expect((await gatewayIdentity(transport(), true))?.role).toBe('admin')
})

it('logout can consume a valid session without requiring any remaining gallery role', async () => {
  const { gatewaySession } = await import('../lib/identity/gateway-auth')
  state.pg.mockResolvedValue({ name: 'ES', epoch: 'logout', revoked: true })
  grants([])
  expect((await gatewaySession(transport()))?.assertion.sid).toBe(
    '12345678-1234-1234-1234-123456789012',
  )
  expect(state.query).not.toHaveBeenCalled()
})

it('shared role snapshots cannot extend the identity cache past their original expiry', async () => {
  vi.useFakeTimers()
  try {
    let inherited = true
    state.pg.mockResolvedValue({ name: 'ES', epoch: 'graph-expiry-first' })
    state.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SHOW USERS')) return [{ name: 'ES', disabled: false }]
      if (sql.startsWith('SHOW GRANTS TO USER'))
        return [{ role: 'SHARED_EXPIRY_TEST', granted_on: 'ROLE', privilege: 'USAGE' }]
      if (sql.includes('"SHARED_EXPIRY_TEST"') && inherited)
        return [{ name: 'PERSONAL_PHOTOS_VIEWER', granted_on: 'ROLE', privilege: 'USAGE' }]
      return []
    })
    expect((await gatewayIdentity(transport()))?.role).toBe('viewer')
    vi.advanceTimersByTime(14000)
    state.pg.mockResolvedValue({ name: 'ES', epoch: 'graph-expiry-second' })
    expect((await gatewayIdentity(transport()))?.role).toBe('viewer')
    inherited = false
    vi.advanceTimersByTime(1001)
    await expect(gatewayIdentity(transport())).rejects.toMatchObject({ status: 403 })
  } finally {
    vi.useRealTimers()
  }
})

it('fails closed when authorization reads consume their entire freshness window', async () => {
  vi.useFakeTimers()
  try {
    grants(['PERSONAL_PHOTOS_VIEWER'])
    const query = state.query.getMockImplementation()!
    state.query.mockImplementation(async (...args: Parameters<typeof query>) => {
      const result = await query(...args)
      if (String(args[0]).startsWith('SHOW USERS')) vi.advanceTimersByTime(15001)
      return result
    })
    await expect(resolveGatewayRoles('ES')).rejects.toMatchObject({ status: 503 })
  } finally {
    vi.useRealTimers()
  }
})

it('binds browse assertions to the actual URL rather than spoofed proxy headers', async () => {
  const { withBrowseRequest } = await import('../lib/browse-request')
  const { gatewayAssertion } = await import('../lib/identity/gateway-auth')
  const h = transport()
  const handler = withBrowseRequest(async (request) => {
    gatewayAssertion(request.headers)
    return new Response(null, { status: 204 })
  })
  expect((await handler(new Request('https://app/api/events', { headers: h }))).status).toBe(204)
  await expect(
    handler(new Request('https://app/api/photos/1', { headers: h })),
  ).rejects.toMatchObject({ status: 401 })
  await expect(
    handler(new Request('https://app/api/events?scope=mine', { headers: h })),
  ).rejects.toMatchObject({ status: 401 })
  await expect(
    handler(new Request('https://app/api/events', { method: 'POST', headers: h })),
  ).rejects.toMatchObject({ status: 401 })
  h.set('x-photo-request-method', 'DELETE')
  h.set('x-photo-request-target', '/api/photos/1')
  expect((await handler(new Request('https://app/api/events', { headers: h }))).status).toBe(204)
})

it('accepts Next query encoding without accepting changed IDs, parameter order, routes or methods', () => {
  const h = transport('PERSONAL_PHOTOS_GATEWAY', '/api/events/1/review?ids=1,2,3&label=a%20b')
  h.set('x-photo-request-target', '/api/events/1/review?ids=1%2C2%2C3&label=a+b')
  expect(gatewayAssertion(h)?.target).toContain('ids=1,2,3')
  for (const target of [
    '/api/events/1/review?ids=1%2C2%2C4&label=a+b',
    '/api/events/2/review?ids=1%2C2%2C3&label=a+b',
    '/api/events/1/review?ids=1%2C2%2C3&ids=4&label=a+b',
    '/api/events/1/review?label=a+b&ids=1%2C2%2C3',
  ]) {
    h.set('x-photo-request-target', target)
    expect(() => gatewayAssertion(h)).toThrow(/binding mismatch/)
  }
  h.set('x-photo-request-target', '/api/events/1/review?ids=1%2C2%2C3&label=a+b')
  h.set('x-photo-request-method', 'POST')
  expect(() => gatewayAssertion(h)).toThrow(/binding mismatch/)
  expect(state.pg).not.toHaveBeenCalled()
})
