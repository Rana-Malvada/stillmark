import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ headers: new Headers(), service: '', query: vi.fn() }))
vi.mock('@/lib/postgres', () => ({ pgAuthEpoch: async () => '1' }))
vi.mock('next/headers', () => ({ headers: async () => state.headers }))
vi.mock('@/lib/snowflake', () => ({
  getServiceToken: () => state.service,
  querySnowflake: state.query,
}))
import {
  getCallerIdentity,
  requireAdmin,
  requireAuth,
  requireSameOrigin,
} from '@/lib/identity/auth'

beforeEach(() => {
  state.headers = new Headers()
  state.service = ''
  state.query.mockReset()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('DEV_AUTH', 'true')
  vi.stubEnv('APP_ORIGIN', '')
})
afterEach(() => vi.unstubAllEnvs())
function caller(token = 'session-one') {
  state.service = 'service'
  state.headers = new Headers({
    'sf-context-current-user': 'alice',
    'sf-context-current-user-token': token,
  })
}
describe('authentication', () => {
  it('fails closed in production even with development override', async () => {
    await expect(requireAuth()).rejects.toMatchObject({ status: 401 })
  })
  it('requires the runtime token as well as supplied headers', async () => {
    caller()
    state.service = ''
    await expect(requireAuth()).rejects.toMatchObject({ status: 401 })
  })
  it('allows ordinary authenticated reads without Snowflake SQL', async () => {
    caller()
    await expect(requireAuth()).resolves.toMatchObject({ username: 'alice' })
    expect(state.query).not.toHaveBeenCalled()
  })
  it('checks current admin grants for each request and rejects viewer mutations', async () => {
    caller('admin-session')
    state.query.mockResolvedValue([{ IS_ADMIN: true }])
    await requireAdmin()
    await requireAdmin()
    expect(state.query).toHaveBeenCalledTimes(2)
    caller('viewer-session')
    state.query.mockResolvedValueOnce([{ IS_ADMIN: false }])
    await expect(requireAdmin()).rejects.toMatchObject({ status: 403 })
    expect(state.query).toHaveBeenCalledTimes(3)
  })
  it('does not turn a failed role check into admin access', async () => {
    caller('failed-session')
    state.query.mockRejectedValue(new Error('unavailable'))
    await expect(getCallerIdentity()).rejects.toThrow('unavailable')
  })
  it('permits explicit local development only outside the runtime', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    await expect(requireAuth()).resolves.toMatchObject({ role: 'admin' })
    state.service = 'service'
    await expect(requireAuth()).rejects.toMatchObject({ status: 401 })
  })
  it('blocks cross-origin and missing-origin writes', async () => {
    state.headers = new Headers({ host: 'photos.example', origin: 'https://evil.example' })
    await expect(requireSameOrigin()).rejects.toMatchObject({ status: 403 })
    state.headers = new Headers({ host: 'photos.example' })
    await expect(requireSameOrigin()).rejects.toMatchObject({ status: 403 })
    state.headers.set('origin', 'https://photos.example')
    await expect(requireSameOrigin()).resolves.toBeUndefined()
  })
})

it('requires a fresh, separate Access Manager role for every access operation', async () => {
  const { requireAccessManager } = await import('@/lib/identity/auth')
  caller('access-manager')
  state.query
    .mockResolvedValueOnce([{ CAN_MANAGE_ACCESS: true }])
    .mockResolvedValueOnce([{ CAN_MANAGE_ACCESS: false }])
  await expect(requireAccessManager()).resolves.toMatchObject({ username: 'alice' })
  await expect(requireAccessManager()).rejects.toMatchObject({ status: 403 })
  expect(state.query).toHaveBeenCalledTimes(2)
  expect(state.query.mock.calls.every((call) => call[1].callersRights === true)).toBe(true)
  caller('photo-admin-only')
  state.query.mockResolvedValue([{ IS_ADMIN: true }])
  await expect(requireAccessManager()).rejects.toMatchObject({ status: 403 })
})
it('allows read-only admin surfaces but rejects photo and identity administration', async () => {
  const { requireAdminRead, requireAccessRead, requireAccessManager } =
    await import('@/lib/identity/auth')
  caller('readonly-session')
  state.query.mockResolvedValue([
    { IS_ADMIN: false, IS_ADMIN_READONLY: true, CAN_MANAGE_ACCESS: false },
  ])
  await expect(requireAdminRead()).resolves.toMatchObject({ role: 'admin_readonly' })
  await expect(requireAccessRead()).resolves.toMatchObject({ role: 'admin_readonly' })
  await expect(requireAdmin()).rejects.toMatchObject({ status: 403 })
  await expect(requireAccessManager()).rejects.toMatchObject({ status: 403 })
})
it('does not grant admin visibility to ordinary viewers or identity management to photo admins', async () => {
  const { requireAdminRead, requireAccessRead } = await import('@/lib/identity/auth')
  caller('plain-viewer-read')
  state.query.mockResolvedValue([{ IS_ADMIN: false, IS_ADMIN_READONLY: false }])
  await expect(requireAdminRead()).rejects.toMatchObject({ status: 403 })
  await expect(requireAccessRead()).rejects.toMatchObject({ status: 403 })
  caller('photo-admin-access-read')
  state.query.mockResolvedValue([
    { IS_ADMIN: true, IS_ADMIN_READONLY: false, CAN_MANAGE_ACCESS: false },
  ])
  await expect(requireAccessRead()).rejects.toMatchObject({ status: 403 })
})
it('preserves admin permissions when both admin roles are assigned', async () => {
  caller('combined-admin-roles')
  state.query.mockResolvedValue([{ IS_ADMIN: true, IS_ADMIN_READONLY: true }])
  await expect(requireAdmin()).resolves.toMatchObject({ role: 'admin' })
})

it('combines viewer personal permissions with read-only administrative visibility', async () => {
  caller('viewer-and-readonly')
  state.query.mockResolvedValue([{ IS_ADMIN: false, IS_ADMIN_READONLY: true, IS_VIEWER: true }])
  await expect(getCallerIdentity()).resolves.toMatchObject({
    role: 'admin_readonly',
    canManagePersonal: true,
  })
  await expect(requireAdmin()).rejects.toMatchObject({ status: 403 })
  caller('readonly-without-viewer')
  state.query.mockResolvedValue([{ IS_ADMIN: false, IS_ADMIN_READONLY: true, IS_VIEWER: false }])
  await expect(getCallerIdentity()).resolves.toMatchObject({
    role: 'admin_readonly',
    canManagePersonal: false,
  })
})

it('recognizes App Owner across cached reads and does not grant it to ordinary admins', async () => {
  caller('app-owner-session')
  state.query.mockResolvedValue([{ IS_APP_OWNER: true, IS_ADMIN: true }])
  await expect(getCallerIdentity()).resolves.toMatchObject({
    role: 'admin',
    appOwner: true,
    canManagePersonal: true,
  })
  await expect(getCallerIdentity()).resolves.toMatchObject({ appOwner: true })
  expect(state.query).toHaveBeenCalledTimes(1)
  caller('ordinary-admin-not-owner')
  state.query.mockResolvedValue([{ IS_ADMIN: true }])
  await expect(getCallerIdentity()).resolves.toMatchObject({ appOwner: false })
})

it('returns retryable unavailability without caching privileges after a connection timeout', async () => {
  const { ConnectionWaitTimeoutError } = await import('@/lib/connection-deadline')
  caller('connection-deadline-session')
  state.query.mockRejectedValueOnce(new ConnectionWaitTimeoutError())
  await expect(getCallerIdentity()).rejects.toMatchObject({ status: 503, retryAfterSeconds: 1 })
  expect(state.query).toHaveBeenLastCalledWith(expect.any(String), {
    callersRights: true,
    connectionWaitMs: 5000,
    connectionProfile: 'role-check',
  })
  state.query.mockResolvedValueOnce([{ IS_ADMIN: false }])
  await expect(getCallerIdentity()).resolves.toMatchObject({ role: 'viewer' })
  expect(state.query).toHaveBeenCalledTimes(2)
})

it('does not let an older failed check remove a newer in-flight authorization check', async () => {
  const { ConnectionWaitTimeoutError } = await import('@/lib/connection-deadline')
  caller('overlapping-fresh-checks')
  let rejectFirst!: (error: Error) => void
  let finishSecond!: (rows: unknown[]) => void
  state.query.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectFirst = reject
      }),
  )
  state.query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSecond = resolve
      }),
  )
  const first = requireAdmin()
  const firstRejected = expect(first).rejects.toMatchObject({ status: 503 })
  await vi.waitFor(() => expect(state.query).toHaveBeenCalledTimes(1))
  const second = requireAdmin()
  await vi.waitFor(() => expect(state.query).toHaveBeenCalledTimes(2))
  rejectFirst(new ConnectionWaitTimeoutError())
  await firstRejected
  const shared = getCallerIdentity()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(state.query).toHaveBeenCalledTimes(2)
  finishSecond([{ IS_ADMIN: true }])
  await expect(second).resolves.toMatchObject({ role: 'admin' })
  await expect(shared).resolves.toMatchObject({ role: 'admin' })
})

it('fails closed on a total query deadline and permits a fresh authorization retry', async () => {
  const { SnowflakeQueryTimeoutError } = await import('@/lib/snowflake/snowflake-query-deadline')
  caller('query-total-deadline-session')
  state.query.mockRejectedValueOnce(new SnowflakeQueryTimeoutError())
  await expect(getCallerIdentity()).rejects.toMatchObject({ status: 503, retryAfterSeconds: 1 })
  state.query.mockResolvedValueOnce([{ IS_ADMIN: false }])
  await expect(getCallerIdentity()).resolves.toMatchObject({ role: 'viewer' })
  expect(state.query).toHaveBeenCalledTimes(2)
})
