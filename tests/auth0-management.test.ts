import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const secret = vi.hoisted(() => vi.fn())
vi.mock('@/lib/snowflake', () => ({ getSecret: secret, SecretType: { PASSWORD: 'PASSWORD' } }))
const marker = '66ac034b-a289-433c-82b6-e04acb868471'
const object = { name: 'JANE', marker, email: 'Jane@example.com', display_name: 'Jane' }
const user = {
  user_id: `auth0|${marker}`,
  app_metadata: { gallery_marker: marker, snowflake_login: 'JANE' },
  identities: [{ provider: 'auth0', connection: 'Username-Password-Authentication' }],
}
const fetchMock = vi.fn()
let api: typeof import('@/lib/identity/auth0-management')
beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('AUTH0_DOMAIN', 'test.us.auth0.com')
  vi.stubEnv('AUTH0_MANAGEMENT_ENABLED', 'true')
  secret.mockReturnValue({ username: 'client', password: 'client-secret' })
  api = await import('@/lib/identity/auth0-management')
  fetchMock.mockResolvedValueOnce(Response.json({ access_token: 'token', expires_in: 3600 }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
it('creates deterministic identities with admin-only ownership and login mapping', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json(user))
  expect(await api.ensureAuth0User(object, 'PrivatePassword1234')).toBe(user.user_id)
  const [url, options] = fetchMock.mock.calls[2]
  expect(url).toBe('https://test.us.auth0.com/api/v2/users')
  expect(JSON.parse(options.body)).toMatchObject({
    user_id: marker,
    username: 'jane',
    email: 'jane@example.com',
    verify_email: false,
    app_metadata: user.app_metadata,
  })
  expect(options.redirect).toBe('error')
})
it('recovers an already-created identity without another POST', async () => {
  fetchMock.mockResolvedValueOnce(Response.json(user))
  expect(await api.ensureAuth0User(object, 'PrivatePassword1234')).toBe(user.user_id)
  expect(fetchMock.mock.calls.filter((c) => c[1].method === 'POST')).toHaveLength(1) // Token only.
})
it('blocks wrong ownership, mappings and linked identities before mutations', async () => {
  for (const changed of [
    { ...user, app_metadata: { ...user.app_metadata, gallery_marker: 'other' } },
    { ...user, app_metadata: { ...user.app_metadata, snowflake_login: 'OWNER' } },
    {
      ...user,
      identities: [...user.identities, { provider: 'google-oauth2', connection: 'google' }],
    },
  ]) {
    expect(() => api.verifyAuth0User(changed, object)).toThrow('ownership')
  }
  fetchMock.mockResolvedValueOnce(Response.json({ ...user, app_metadata: {} }))
  await expect(api.deleteAuth0User(object)).rejects.toMatchObject({ status: 409 })
  expect(fetchMock.mock.calls.some((c) => c[1].method === 'DELETE')).toBe(false)
})
it('sanitizes upstream errors and never adopts a conflicting account', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ message: 'PrivatePassword1234' }, { status: 409 }))
  await expect(api.ensureAuth0User(object, 'PrivatePassword1234')).rejects.toThrow(
    'never automatically',
  )
})
it('treats missing users as deleted, but never recreates a missing linked identity', async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
  await api.deleteAuth0User(object)
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
  await expect(
    api.ensureAuth0User({ ...object, auth0_user_id: user.user_id }, 'PrivatePassword1234'),
  ).rejects.toMatchObject({ status: 409 })
})
it('verifies identity and sends password changes only to the fixed Auth0 endpoint', async () => {
  fetchMock.mockResolvedValueOnce(Response.json(user)).mockResolvedValueOnce(Response.json(user))
  await api.setAuth0Password({ ...object, auth0_user_id: user.user_id }, 'PrivatePassword1234')
  expect(fetchMock.mock.calls[2][0]).toContain(encodeURIComponent(user.user_id))
  expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
    password: 'PrivatePassword1234',
    connection: 'Username-Password-Authentication',
  })
})
it('rejects arbitrary hosts before sending credentials', async () => {
  vi.stubEnv('AUTH0_DOMAIN', 'evil.example/path')
  await expect(api.inspectAuth0User(object)).rejects.toMatchObject({ status: 503 })
  expect(fetchMock).not.toHaveBeenCalled()
})
it('explains weak passwords without exposing upstream content', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(
      Response.json(
        { message: 'PasswordStrengthError: Password is too weak PrivatePassword1234' },
        { status: 400 },
      ),
    )
  await expect(api.ensureAuth0User(object, 'PrivatePassword1234')).rejects.toThrow(
    'Auth0 rejected this password as too weak.',
  )
})
it('keeps unknown validation errors sanitized', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ message: 'PrivatePassword1234' }, { status: 400 }))
  await expect(api.ensureAuth0User(object, 'PrivatePassword1234')).rejects.toThrow(
    'Auth0 rejected the account details or password.',
  )
})
it('bootstraps by log ID and validates checkpoint links', async () => {
  fetchMock.mockResolvedValueOnce(Response.json([{ log_id: '123' }]))
  expect(await api.readAuth0LogPage()).toEqual({ logs: [{ log_id: '123' }], cursor: '123' })
  expect(fetchMock.mock.calls[1][0]).toContain('sort=log_id%3A1')
  fetchMock.mockResolvedValueOnce(
    Response.json([{ log_id: '124' }], {
      headers: { link: '<https://test.us.auth0.com/api/v2/logs?from=124&take=100>; rel="next"' },
    }),
  )
  expect((await api.readAuth0LogPage('123')).cursor).toBe('124')
  fetchMock.mockResolvedValueOnce(
    Response.json([], {
      headers: { link: '<https://evil.example/api/v2/logs?from=125>; rel="next"' },
    }),
  )
  await expect(api.readAuth0LogPage('124')).rejects.toThrow('checkpoint')
})
it('reports missing log scope without exposing upstream errors', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ message: 'sensitive' }, { status: 403 }))
  await expect(api.readAuth0LogPage()).rejects.toThrow('read:logs')
})
it('public registrations use the stored subject, never email or mutable metadata for ownership', () => {
  const publicAccount = {
    ...object,
    registration_source: 'public',
    auth0_user_id: 'auth0|self-registered',
  }
  const publicUser = { ...user, user_id: 'auth0|self-registered', app_metadata: {} }
  expect(() => api.verifyAuth0User(publicUser, publicAccount)).not.toThrow()
  expect(() =>
    api.verifyAuth0User({ ...publicUser, user_id: 'auth0|different' }, publicAccount),
  ).toThrow('ownership')
  expect(() =>
    api.verifyAuth0User(
      { ...publicUser, identities: [{ provider: 'google-oauth2', connection: 'google' }] },
      publicAccount,
    ),
  ).toThrow('ownership')
  expect(() => api.verifyAuth0User(publicUser, { ...publicAccount, auth0_user_id: null })).toThrow(
    'ownership',
  )
})
