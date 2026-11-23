import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHmac, randomUUID } from 'node:crypto'
import { deployment } from '@/config/deployment.mjs'

// Exercise real route handlers and shared authorization/owner commands. Only the
// provider identity response and database/storage adapters are synthetic. Native
// RLS tests separately prove SQL policies; these cases prove handler ordering.
const state = vi.hoisted(() => ({
  headers: new Headers(),
  role: 'viewer' as 'viewer' | 'admin_readonly' | 'admin',
  sql: vi.fn(),
  provider: vi.fn(),
  register: vi.fn(),
  credential: vi.fn(),
  revoke: vi.fn(),
  external: vi.fn(),
  activity: vi.fn(),
  gateway: false,
  gatewayIdentity: vi.fn(),
}))
vi.mock('next/headers', () => ({ headers: async () => state.headers }))
vi.mock('@/lib/postgres', () => ({
  pgAuthEpoch: async () => 'authorization-matrix',
  pgQuery: state.sql,
  pgQueryOne: async (sql: string, values: unknown[]) => (await state.sql(sql, values))[0] ?? null,
  pgTransaction: async (fn: () => unknown) => fn(),
  getDatabaseIdentity: async () => ({
    username: 'ALICE',
    mainAdmin: false,
    adminRead: state.role !== 'viewer',
    adminWrite: state.role === 'admin',
    canWrite: state.role !== 'admin_readonly',
    accessManager: false,
  }),
  pgRegisterCustomer: state.register,
  pgCredentialChange: state.credential,
  pgAuthRevoke: state.revoke,
  pgAuthGateway: state.gatewayIdentity,
  pgReadRoleCache: async () => undefined,
  pgWriteRoleCache: async () => undefined,
  withAdvisoryLock: async (_key: string, fn: () => unknown) => fn(),
}))
vi.mock('@/lib/snowflake', () => ({
  getServiceToken: () => 'synthetic-runtime',
  querySnowflake: state.provider,
  querySnowflakeStorage: state.external,
  getSnowflakeBaseUrl: () => 'https://synthetic.snowflakecomputing.com',
  getRestApiAuthHeader: () => 'Bearer synthetic-only',
  getSecret: () => 'a'.repeat(64),
  SecretType: { GENERIC_STRING: 'GENERIC_STRING' },
}))
vi.mock('@/lib/observability/activity-action', () => ({ trackAction: state.activity }))

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
type Route = {
  path: string
  load: () => Promise<unknown>
  methods: Method[]
}
const routes: Route[] = [
  {
    path: 'account/bootstrap',
    load: () => import('@/app/api/account/bootstrap/route'),
    methods: ['POST'],
  },
  {
    path: 'account/credential-change',
    load: () => import('@/app/api/account/credential-change/route'),
    methods: ['POST'],
  },
  {
    path: 'account',
    load: () => import('@/app/api/account/route'),
    methods: ['GET', 'PATCH', 'DELETE'],
  },
  {
    path: 'admin/customer-allowance',
    load: () => import('@/app/api/admin/customer-allowance/route'),
    methods: ['POST'],
  },
  {
    path: 'admin/customer-defaults',
    load: () => import('@/app/api/admin/customer-defaults/route'),
    methods: ['GET', 'PATCH'],
  },
  {
    path: 'admin/face-scan',
    load: () => import('@/app/api/admin/face-scan/route'),
    methods: ['GET', 'POST'],
  },
  {
    path: 'admin/video-analysis',
    load: () => import('@/app/api/admin/video-analysis/route'),
    methods: ['GET'],
  },
  { path: 'ai-categorize', load: () => import('@/app/api/ai-categorize/route'), methods: ['POST'] },
  {
    path: 'auth/logout-url',
    load: () => import('@/app/api/auth/logout-url/route'),
    methods: ['GET'],
  },
  { path: 'auth/me', load: () => import('@/app/api/auth/me/route'), methods: ['GET'] },
  {
    path: 'auth/revoke-session',
    load: () => import('@/app/api/auth/revoke-session/route'),
    methods: ['POST'],
  },
  { path: 'csp-report', load: () => import('@/app/api/csp-report/route'), methods: ['POST'] },
  {
    path: 'events/[eventId]/links',
    load: () => import('@/app/api/events/[eventId]/links/route'),
    methods: ['GET', 'POST', 'DELETE'],
  },
  { path: 'health/ready', load: () => import('@/app/api/health/ready/route'), methods: ['GET'] },
  { path: 'my-costs', load: () => import('@/app/api/my-costs/route'), methods: ['GET'] },
  {
    path: 'people/[personId]/ignore',
    load: () => import('@/app/api/people/[personId]/ignore/route'),
    methods: ['POST'],
  },
  { path: 'people/assign', load: () => import('@/app/api/people/assign/route'), methods: ['POST'] },
  { path: 'people/groups', load: () => import('@/app/api/people/groups/route'), methods: ['POST'] },
  {
    path: 'people/history',
    load: () => import('@/app/api/people/history/route'),
    methods: ['GET'],
  },
  { path: 'people/ignore', load: () => import('@/app/api/people/ignore/route'), methods: ['POST'] },
  { path: 'people/merge', load: () => import('@/app/api/people/merge/route'), methods: ['POST'] },
  {
    path: 'people/options',
    load: () => import('@/app/api/people/options/route'),
    methods: ['GET'],
  },
  { path: 'people/review', load: () => import('@/app/api/people/review/route'), methods: ['GET'] },
  { path: 'people', load: () => import('@/app/api/people/route'), methods: ['GET'] },
  {
    path: 'people/settings',
    load: () => import('@/app/api/people/settings/route'),
    methods: ['GET', 'PATCH', 'DELETE'],
  },
  { path: 'people/undo', load: () => import('@/app/api/people/undo/route'), methods: ['POST'] },
  {
    path: 'people/unknown',
    load: () => import('@/app/api/people/unknown/route'),
    methods: ['GET'],
  },
  {
    path: 'photos/[photoId]/analysis',
    load: () => import('@/app/api/photos/[photoId]/analysis/route'),
    methods: ['GET', 'POST'],
  },
]
const person = '22222222-2222-4222-8222-222222222222'
const other = '33333333-3333-4333-8333-333333333333'
const body = () => ({
  confirmation: 'DELETE',
  displayName: 'Changed',
  username: 'BOB',
  uploads: 10,
  bytes: 100,
  storageGiB: 1,
  action: 'ignore',
  id: person,
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  allowDownloads: false,
  faceIds: [99],
  personId: person,
  groupIds: [person],
  ignored: true,
  keep: person,
  absorb: [other],
  enabled: false,
})
async function request(route: Route, method: Method, value = body(), query = '') {
  const routeModule = (await route.load()) as Record<
    Method,
    (req: Request, ctx: unknown) => Promise<Response>
  >
  const url =
    'https://gallery.example/api/' +
    route.path.replace('[personId]', person).replace('[eventId]', '99').replace('[photoId]', '99') +
    query
  if (state.gateway) {
    const target = new URL(url).pathname + new URL(url).search
    const now = Math.floor(Date.now() / 1000)
    const payload = Buffer.from(
      JSON.stringify({
        method,
        target,
        aud: 'https://gallery.example',
        sub: 'auth0|matrix',
        sid: '11111111-1111-4111-8111-111111111111',
        jti: randomUUID(),
        iat: now,
        exp: now + 30,
      }),
    ).toString('base64url')
    state.headers.set('x-photo-request-method', method)
    state.headers.set('x-photo-request-target', target)
    state.headers.set(
      'x-photo-gateway-identity',
      payload +
        '.' +
        createHmac('sha256', Buffer.from('a'.repeat(64), 'hex'))
          .update(payload)
          .digest('base64url'),
    )
  }
  return routeModule[method](
    new Request(url, {
      method,
      ...(method === 'GET' ? {} : { body: JSON.stringify(value) }),
    }),
    { params: Promise.resolve({ eventId: '99', photoId: '99', personId: person }) },
  )
}
function noEffects() {
  expect(state.sql).not.toHaveBeenCalled()
  expect(state.register).not.toHaveBeenCalled()
  expect(state.credential).not.toHaveBeenCalled()
  expect(state.revoke).not.toHaveBeenCalled()
  expect(state.external).not.toHaveBeenCalled()
  expect(state.activity).not.toHaveBeenCalled()
}
function signIn(role: typeof state.role) {
  state.role = role
  state.headers.set('sf-context-current-user', 'ALICE')
  state.headers.set('sf-context-current-user-token', randomUUID())
}
function gatewaySignIn(role: typeof state.role) {
  signIn(role)
  state.gateway = true
  state.headers.set('sf-context-current-user', deployment.GATEWAY_USER)
  vi.stubEnv('APP_PERMISSION_AUTHORITY', 'postgres')
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('APP_ORIGIN', 'https://gallery.example')
  vi.stubEnv('GATEWAY_ORIGIN', 'https://gallery.example')
  vi.stubEnv('APP_PERMISSION_AUTHORITY', 'snowflake')
  vi.stubEnv('CUSTOMER_ACCOUNTS_ENABLED', 'true')
  vi.stubEnv('GATEWAY_AUTH_ENABLED', 'true')
  vi.stubEnv('NATIVE_ROLE_CACHE_SIGNING_KEY', '')
  state.headers = new Headers({ origin: 'https://gallery.example', host: 'gallery.example' })
  state.role = 'viewer'
  state.gateway = false
  state.gatewayIdentity.mockImplementation(async () => ({
    name: 'ALICE',
    marker: '22222222-2222-4222-8222-222222222222',
    epoch: '1',
    revoked: false,
    enabled: true,
    app_role: state.role,
    app_owner: false,
    can_manage_personal: state.role !== 'admin_readonly',
    can_manage_access: false,
    main_admin: false,
  }))
  state.sql.mockResolvedValue([])
  state.provider.mockImplementation(async () => [
    {
      IS_ADMIN: state.role === 'admin',
      IS_ADMIN_READONLY: state.role === 'admin_readonly',
      IS_VIEWER: state.role === 'viewer',
      IS_APP_OWNER: false,
      CAN_MANAGE_ACCESS: false,
    },
  ])
})
afterEach(() => vi.unstubAllEnvs())

for (const route of routes)
  for (const method of route.methods) {
    it(`${method} ${route.path} rejects unauthenticated requests before reading or writing private data`, async () => {
      if (route.path === 'account/bootstrap') vi.stubEnv('APP_PERMISSION_AUTHORITY', 'postgres')
      expect((await request(route, method)).status).toBe(401)
      noEffects()
    })
  }

const administrative = routes.filter(
  (r) => r.path.startsWith('admin/') || ['ai-categorize', 'health/ready'].includes(r.path),
)
for (const role of ['viewer', 'admin_readonly'] as const)
  for (const route of administrative)
    for (const method of route.methods) {
      it(`${role} cannot ${method} ${route.path} through the real privilege guard`, async () => {
        signIn(role)
        expect((await request(route, method)).status).toBe(403)
        noEffects()
      })
    }

for (const route of routes.filter((r) => r.path.startsWith('people/')))
  for (const method of route.methods.filter((m) => m !== 'GET')) {
    it(`read-only caller cannot ${method} ${route.path} or record a correction`, async () => {
      signIn('admin_readonly')
      expect((await request(route, method)).status).toBe(403)
      noEffects()
    })
  }

for (const route of routes.filter((r) =>
  [
    'people/[personId]/ignore',
    'people/assign',
    'people/groups',
    'people/ignore',
    'people/merge',
    'events/[eventId]/links',
    'photos/[photoId]/analysis',
  ].includes(r.path),
)) {
  it(`foreign IDs cannot mutate through ${route.path}`, async () => {
    signIn('viewer')
    const response = await request(
      route,
      route.path === 'events/[eventId]/links' ? 'DELETE' : 'POST',
    )
    expect(response.status).toBe(route.path === 'photos/[photoId]/analysis' ? 403 : 404)
    expect(state.sql.mock.calls.some(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(
      false,
    )
    expect(state.activity).not.toHaveBeenCalled()
    expect(state.external).not.toHaveBeenCalled()
  })
}

it('ordinary users cannot request another user or all-user costs before any service read', async () => {
  signIn('viewer')
  const route = routes.find((r) => r.path === 'my-costs')!
  for (const user of ['BOB', 'all'])
    expect((await request(route, 'GET', body(), '?user=' + user)).status).toBe(403)
  noEffects()
})

it('forged gateway events never register, change credentials or revoke a supplied session', async () => {
  const { deployment } = await import('@/config/deployment.mjs')
  state.headers.set('sf-context-current-user', deployment.GATEWAY_USER)
  state.headers.set('sf-context-current-user-token', 'synthetic-platform-token')
  state.headers.set('x-photo-gateway-identity', 'forged.assertion')
  vi.stubEnv('APP_PERMISSION_AUTHORITY', 'postgres')
  for (const route of routes.filter((r) =>
    ['account/bootstrap', 'account/credential-change', 'auth/revoke-session'].includes(r.path),
  )) {
    expect((await request(route, 'POST')).status).toBe(401)
  }
  noEffects()
})

it('provider authorization unavailability fails closed before administrative writes', async () => {
  signIn('admin')
  state.provider.mockRejectedValue(new Error('Synthetic provider unavailable'))
  const route = routes.find((r) => r.path === 'admin/customer-allowance')!
  expect((await request(route, 'POST')).status).toBe(500)
  noEffects()
})

it('public liveness reveals only a static status and performs no private work', async () => {
  const { GET } = await import('@/app/api/health/live/route')
  const response = GET()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'ok' })
  noEffects()
})

for (const role of ['viewer', 'admin_readonly'] as const)
  for (const route of administrative)
    for (const method of route.methods) {
      it(`Postgres gateway ${role} cannot ${method} ${route.path}`, async () => {
        gatewaySignIn(role)
        expect((await request(route, method)).status).toBe(403)
        noEffects()
      })
    }

for (const route of routes.filter((r) => r.path.startsWith('people/')))
  for (const method of route.methods.filter((m) => m !== 'GET')) {
    it(`Postgres gateway read-only cannot ${method} ${route.path}`, async () => {
      gatewaySignIn('admin_readonly')
      expect((await request(route, method)).status).toBe(403)
      noEffects()
    })
  }

it('revoked PostgreSQL gateway sessions cannot read account identity', async () => {
  gatewaySignIn('viewer')
  state.gatewayIdentity.mockResolvedValue({
    name: 'ALICE',
    revoked: true,
    enabled: true,
    app_role: 'viewer',
  })
  expect(
    (
      await request(
        routes.find((r) => r.path === 'auth/me')!,
        'GET',
      )
    ).status,
  ).toBe(401)
  noEffects()
})
