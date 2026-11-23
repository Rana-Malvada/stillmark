import { legacyIdentityCommand } from './identity-fixture'
import { beforeEach, expect, it, vi } from 'vitest'

const auth0 = vi.hoisted(() => ({
  enabled: vi.fn(),
  ensure: vi.fn(),
  inspect: vi.fn(),
  password: vi.fn(),
  delete: vi.fn(),
}))
vi.mock('@/lib/identity/auth0-management', () => ({
  auth0Enabled: auth0.enabled,
  ensureAuth0User: auth0.ensure,
  inspectAuth0User: auth0.inspect,
  setAuth0Password: auth0.password,
  deleteAuth0User: auth0.delete,
}))
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  one: vi.fn(),
  sf: vi.fn(),
  lock: vi.fn(),
  manager: vi.fn(),
  origin: vi.fn(),
}))
vi.mock('@/lib/postgres', () => ({
  pgQuery: mocks.query,
  pgQueryOne: (sql: string, ...args: unknown[]) =>
    sql.startsWith('SELECT username FROM gallery_main_admins')
      ? Promise.resolve(sql.includes('WHERE') ? null : { username: 'OWNER' })
      : mocks.one(sql, ...args),
  pgTransaction: async (fn: Function) => fn(),
  withAdvisoryLock: mocks.lock,
}))
vi.mock('@/lib/snowflake', () => ({ querySnowflake: mocks.sf }))
vi.mock('@/lib/identity/auth', () => ({
  requireAccessRead: mocks.manager,
  requireAccessManager: mocks.manager,
  requireSameOrigin: mocks.origin,
}))
import { accessRequest, operationId, runAccessOperation } from '@/lib/access-management'
import { GET, POST } from '@/app/api/admin/access/route'
import { HttpError } from '@/lib/http'

const id = '66ac034b-a289-433c-82b6-e04acb868471'
const user = {
  kind: 'user',
  name: 'JANE',
  marker: id,
  state: 'ready',
  display_name: 'Jane',
  email: 'jane@example.com',
}
const request = {
  action: 'createUser' as const,
  name: 'JANE',
  displayName: 'Jane',
  email: 'jane@example.com',
}
const marker = `Personal Photos managed access ${id}`
it('preserves public account identifiers when changing roles or disabling an account', () => {
  const name = 'U_00000000000000000000000000000001'
  expect(accessRequest({ action: 'grantRole', name, role: 'STILLMARK_MEMBER' }).name).toBe(name)
  expect(accessRequest({ action: 'deleteUser', name, marker: id, confirmation: name }).name).toBe(
    name,
  )
})
beforeEach(() => {
  vi.resetAllMocks()
  mocks.lock.mockImplementation((_key, fn) => fn())
  mocks.query.mockResolvedValue([])
  mocks.sf.mockResolvedValue([])
  mocks.manager.mockResolvedValue({ username: 'OWNER' })
})
it('validates identifiers, emails, profiles and request IDs without accepting SQL or privileged roles', () => {
  expect(accessRequest({ ...request, name: 'jane' })).toEqual(request)
  for (const body of [
    { ...request, name: 'JANE"; DROP USER X' },
    { ...request, email: 'not-email' },
    { ...request, name: 'ACCOUNTADMIN' },
    { action: 'createRole', name: 'SYSADMIN', displayName: 'x', profile: 'admin' },
    {
      action: 'createRole',
      name: 'PERSONAL_PHOTOS_GROUP_X',
      displayName: 'x',
      profile: 'access_manager',
    },
  ])
    expect(() => accessRequest(body)).toThrow(HttpError)
  expect(() => operationId('invalid')).toThrow(HttpError)
})
it('requires literal supported role profiles before creating an access operation', async () => {
  const body = {
    action: 'createRole',
    name: 'PERSONAL_PHOTOS_GROUP_TEAM',
    displayName: 'Team',
  }
  for (const profile of ['viewer', 'admin', 'admin_readonly']) {
    expect(accessRequest({ ...body, profile })).toEqual({ ...body, profile })
    for (const value of [
      [profile],
      [[profile]],
      { value: profile },
      { toString: () => profile },
      new String(profile),
      Object.create(null),
      null,
      undefined,
      0,
      true,
      'app_owner',
      'access_manager',
    ])
      expect(() => accessRequest({ ...body, profile: value })).toThrow(HttpError)

    for (const value of [[profile], [[profile]], { value: profile }]) {
      const response = await POST(
        new Request('https://app/api/admin/access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, profile: value, operationId: id }),
        }),
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Choose Viewer, Admin or Read-only admin' })
    }
  }
  expect(mocks.manager).toHaveBeenCalledTimes(9)
  expect(mocks.origin).toHaveBeenCalledTimes(9)
  expect(mocks.lock).not.toHaveBeenCalled()
  expect(mocks.query).not.toHaveBeenCalled()
  expect(mocks.one).not.toHaveBeenCalled()
  expect(mocks.sf).not.toHaveBeenCalled()
  expect(auth0.ensure).not.toHaveBeenCalled()
})
it('checks manager and origin before any provisioning or listing', async () => {
  mocks.manager.mockRejectedValue(new HttpError(403, 'Manager required'))
  expect((await GET()).status).toBe(403)
  expect(
    (
      await POST(
        new Request('https://app/api/admin/access', {
          method: 'POST',
          body: JSON.stringify({ ...request, operationId: id }),
        }),
      )
    ).status,
  ).toBe(403)
  mocks.manager.mockResolvedValue({ username: 'OWNER' })
  mocks.origin.mockRejectedValue(new HttpError(403, 'Wrong origin'))
  expect(
    (
      await POST(
        new Request('https://app/api/admin/access', {
          method: 'POST',
          body: JSON.stringify({ ...request, operationId: id }),
        }),
      )
    ).status,
  ).toBe(403)
  expect(mocks.sf).not.toHaveBeenCalled()
  expect(mocks.query).not.toHaveBeenCalled()
})
it('records intent before creating an account, never creates a password or grants access automatically', async () => {
  mocks.one.mockResolvedValue(null)
  mocks.query.mockImplementation(async (sql) =>
    sql.startsWith('INSERT INTO gallery_access_objects') ? [user] : [],
  )
  await runAccessOperation('OWNER', id, request)
  const commands = mocks.sf.mock.calls.map((c) => c[0])
  expect(commands.find((s) => s.startsWith('CREATE USER'))).toContain('TYPE=PERSON')
  expect(commands.find((s) => s.startsWith('CREATE USER'))).toContain(
    'NETWORK_POLICY=PERSONAL_PHOTOS_NO_DIRECT_LOGIN',
  )
  expect(commands.find((s) => s.startsWith('CREATE USER'))).not.toContain('PASSWORD')
  expect(commands.some((s) => s.startsWith('GRANT'))).toBe(false)
  expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(mocks.sf.mock.invocationCallOrder[0])
})
it('does not adopt existing users, including names matched through SHOW wildcards', async () => {
  mocks.one.mockResolvedValue(null)
  mocks.sf.mockResolvedValue([{ name: 'JANE', comment: '' }])
  await expect(runAccessOperation('OWNER', id, request)).rejects.toMatchObject({ status: 409 })
  expect(mocks.sf.mock.calls.some((c) => c[0].startsWith('CREATE'))).toBe(false)
})
it('resumes creation after Snowflake succeeded but metadata update failed', async () => {
  mocks.one
    .mockResolvedValueOnce({ actor: 'OWNER', request, state: 'failed' })
    .mockResolvedValueOnce(user)
  mocks.sf.mockResolvedValue([{ name: 'JANE', comment: marker }])
  await runAccessOperation('OWNER', id, request)
  expect(mocks.sf.mock.calls.some((c) => c[0].startsWith('CREATE'))).toBe(false)
  expect(mocks.sf).toHaveBeenCalledWith(
    'ALTER USER "JANE" SET NETWORK_POLICY=PERSONAL_PHOTOS_NO_DIRECT_LOGIN',
  )
  expect(mocks.query.mock.calls.some((c) => c[0].includes("state='ready'"))).toBe(true)
})
it('does not enable Auth0 or finish interrupted provisioning if the network restriction fails', async () => {
  auth0.enabled.mockReturnValue(true)
  const retry = { ...request, password: 'ExamplePassword123' }
  mocks.one
    .mockResolvedValueOnce({ actor: 'OWNER', request: retry, state: 'failed' })
    .mockResolvedValueOnce(user)
  mocks.sf.mockImplementation(async (sql) =>
    sql.startsWith('ALTER USER')
      ? Promise.reject(new Error('policy missing'))
      : [{ name: 'JANE', comment: marker }],
  )
  await expect(runAccessOperation('OWNER', id, retry)).rejects.toBeDefined()
  expect(auth0.ensure).not.toHaveBeenCalled()
  expect(mocks.query.mock.calls.some((c) => c[0].includes("state='ready'"))).toBe(false)
})
it('rejects conflicting retries and replays completed actions without more SQL', async () => {
  mocks.one.mockResolvedValue({
    actor: 'OTHER',
    request,
    state: 'succeeded',
    result: { message: 'done' },
  })
  await expect(runAccessOperation('OWNER', id, request)).rejects.toMatchObject({ status: 409 })
  mocks.one.mockResolvedValue({
    actor: 'OWNER',
    request: { email: request.email, displayName: 'Jane', name: 'JANE', action: 'createUser' },
    state: 'succeeded',
    result: { message: 'done' },
  })
  expect(await runAccessOperation('OWNER', id, request)).toEqual({ message: 'done' })
  expect(mocks.sf).not.toHaveBeenCalled()
})
it('refuses arbitrary users and protected role assignment', async () => {
  mocks.one.mockResolvedValue(null)
  await expect(
    runAccessOperation('OWNER', id, { action: 'grantRole', name: 'JANE', role: 'ACCOUNTADMIN' }),
  ).rejects.toMatchObject({ status: 409 })
  mocks.one.mockResolvedValueOnce(null).mockResolvedValueOnce(user).mockResolvedValueOnce(null)
  mocks.sf.mockImplementation(async (sql) =>
    sql.startsWith('SHOW USERS') ? [{ name: 'JANE', comment: marker }] : [],
  )
  await expect(
    runAccessOperation('OWNER', id, { action: 'grantRole', name: 'JANE', role: 'ACCOUNTADMIN' }),
  ).rejects.toMatchObject({ status: 409 })
  expect(mocks.sf.mock.calls.some((c) => c[0].startsWith('GRANT'))).toBe(false)
})
it('refuses setup for accounts promoted outside the gallery', async () => {
  mocks.one.mockResolvedValueOnce(null).mockResolvedValueOnce(user)
  mocks.sf.mockImplementation(async (sql) =>
    sql.startsWith('SHOW USERS')
      ? [{ name: 'JANE', comment: marker }]
      : [{ role: 'ACCOUNTADMIN', granted_on: 'ROLE', privilege: 'USAGE' }],
  )
  await expect(
    runAccessOperation('OWNER', id, { action: 'setupLink', name: 'JANE' }),
  ).rejects.toMatchObject({ status: 409 })
  expect(mocks.sf.mock.calls.some((c) => c[0].startsWith('ALTER'))).toBe(false)
})
it('keeps reset links out of persisted results and returns them only for the original operation', async () => {
  mocks.one.mockResolvedValueOnce(null).mockResolvedValueOnce(user)
  const url = 'https://example.snowflakecomputing.com/reset?token=private'
  mocks.sf.mockImplementation(async (sql) =>
    sql.startsWith('SHOW USERS')
      ? [{ name: 'JANE', comment: marker }]
      : sql.startsWith('SHOW GRANTS TO USER')
        ? [{ role: 'PERSONAL_PHOTOS_VIEWER', granted_on: 'ROLE', privilege: 'USAGE' }]
        : sql.startsWith('ALTER')
          ? [{ status: url }]
          : [],
  )
  expect(
    await runAccessOperation('OWNER', id, { action: 'setupLink', name: 'JANE' }),
  ).toMatchObject({ setupUrl: url })
  expect(JSON.stringify(mocks.query.mock.calls)).not.toContain('token=private')
})
it('repairs default role after revocation and records partial failures for retry', async () => {
  mocks.one.mockResolvedValueOnce(null).mockResolvedValueOnce(user)
  mocks.sf.mockImplementation(async (sql) =>
    sql.startsWith('SHOW USERS')
      ? [{ name: 'JANE', comment: marker }]
      : sql.startsWith('REVOKE')
        ? Promise.reject(new Error('network failed'))
        : [],
  )
  await expect(
    runAccessOperation('OWNER', id, {
      action: 'revokeRole',
      name: 'JANE',
      role: 'PERSONAL_PHOTOS_VIEWER',
    }),
  ).rejects.toMatchObject({ status: 502 })
  expect(mocks.query.mock.calls.some((c) => c[0].includes("state='failed'"))).toBe(true)
  mocks.one.mockResolvedValueOnce(null).mockResolvedValueOnce(user)
  mocks.sf.mockImplementation(async (sql) =>
    sql.startsWith('SHOW USERS') ? [{ name: 'JANE', comment: marker }] : [],
  )
  await runAccessOperation('OWNER', id, {
    action: 'revokeRole',
    name: 'JANE',
    role: 'PERSONAL_PHOTOS_VIEWER',
  })
  expect(
    mocks.sf.mock.calls.some((c) => c[0] === 'ALTER USER "JANE" SET DEFAULT_ROLE=\'PUBLIC\''),
  ).toBe(true)
})
it('rejects externally expanded custom roles and serializes overlapping changes', async () => {
  mocks.one.mockResolvedValueOnce(null).mockResolvedValueOnce(user).mockResolvedValueOnce({
    kind: 'role',
    name: 'PERSONAL_PHOTOS_GROUP_TEAM',
    marker: id,
    profile: 'viewer',
    state: 'ready',
  })
  mocks.sf.mockImplementation(async (sql) =>
    sql.startsWith('SHOW USERS')
      ? [{ name: 'JANE', comment: marker }]
      : sql.startsWith('SHOW ROLES')
        ? [{ name: 'PERSONAL_PHOTOS_GROUP_TEAM', comment: marker }]
        : sql.startsWith('SHOW GRANTS TO ROLE')
          ? [{ granted_on: 'ACCOUNT', name: 'ACCOUNT', privilege: 'MANAGE GRANTS' }]
          : [],
  )
  await expect(
    runAccessOperation('OWNER', id, {
      action: 'grantRole',
      name: 'JANE',
      role: 'PERSONAL_PHOTOS_GROUP_TEAM',
    }),
  ).rejects.toMatchObject({ status: 409 })
  mocks.lock.mockResolvedValue(null)
  await expect(runAccessOperation('OWNER', id, request)).rejects.toMatchObject({ status: 409 })
})
it('creates password users without a reset link and keeps credentials out of the audit journal', async () => {
  const password = "StrongPass1234'\\Secret"
  mocks.one.mockResolvedValue(null)
  mocks.query.mockImplementation(async (sql) =>
    sql.startsWith('INSERT INTO gallery_access_objects') ? [user] : [],
  )
  await runAccessOperation('OWNER', id, accessRequest({ ...request, password }))
  const command = mocks.sf.mock.calls.map((c) => c[0]).find((s) => s.startsWith('CREATE USER'))
  expect(command).toContain("PASSWORD='StrongPass1234''\\\\Secret'")
  expect(command).toContain('MUST_CHANGE_PASSWORD=FALSE')
  expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(password)
  expect(JSON.stringify(mocks.query.mock.calls)).toContain('[REDACTED]')
})
it('sets a managed user password without disclosing it through an error or audit record', async () => {
  const password = 'PrivatePassword1234'
  mocks.one.mockResolvedValueOnce(null).mockResolvedValueOnce(user)
  mocks.sf.mockImplementation(async (sql) =>
    sql.startsWith('SHOW USERS')
      ? [{ name: 'JANE', comment: marker }]
      : sql.startsWith('ALTER')
        ? Promise.reject(new Error(password))
        : [],
  )
  await expect(
    runAccessOperation('OWNER', id, { action: 'setPassword', name: 'JANE', password }),
  ).rejects.toMatchObject({ status: 502 })
  expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(password)
  expect(mocks.sf.mock.calls.some((c) => c[0].includes('MUST_CHANGE_PASSWORD=FALSE'))).toBe(true)
})
it('does not replay successful password changes or allow password changes to self', async () => {
  const req = { action: 'setPassword' as const, name: 'JANE', password: 'PrivatePassword1234' }
  mocks.one.mockResolvedValueOnce({
    actor: 'OWNER',
    request: { ...req, password: '[REDACTED]' },
    state: 'succeeded',
    result: { message: 'done' },
  })
  expect(await runAccessOperation('OWNER', id, req)).toEqual({ message: 'done' })
  expect(mocks.sf).not.toHaveBeenCalled()
  mocks.one.mockResolvedValueOnce(null)
  await expect(runAccessOperation('JANE', id, req)).rejects.toMatchObject({ status: 403 })
})
it('validates passwords without trimming them or permitting audit placeholders', () => {
  for (const password of [
    'short',
    '[REDACTED]',
    'a'.repeat(257),
    'NoNumbersAtAllHere',
    'Lowercase1234\nA',
  ])
    expect(() => accessRequest({ ...request, password })).toThrow(HttpError)
  expect(accessRequest({ ...request, password: '  ValidPassword1234  ' })).toMatchObject({
    password: '  ValidPassword1234  ',
  })
})
it('creates read-only groups by inheriting only the read-only base role', async () => {
  const req = accessRequest({
    action: 'createRole',
    name: 'PERSONAL_PHOTOS_GROUP_AUDIT',
    displayName: 'Audit',
    profile: 'admin_readonly',
  })
  mocks.one.mockResolvedValue(null)
  mocks.query.mockImplementation(async (sql) =>
    sql.startsWith('INSERT INTO gallery_access_objects')
      ? [{ ...user, kind: 'role', name: req.name }]
      : [],
  )
  await runAccessOperation('OWNER', id, req)
  const grants = mocks.sf.mock.calls.map((c) => c[0]).filter((s) => s.startsWith('GRANT'))
  expect(grants).toEqual([
    'GRANT ROLE "PERSONAL_PHOTOS_ADMIN_READONLY" TO ROLE "PERSONAL_PHOTOS_GROUP_AUDIT"',
  ])
})
it('requires exact confirmation and an account incarnation for deletion', () => {
  expect(() =>
    accessRequest({ action: 'deleteUser', name: 'JANE', marker: id, confirmation: 'jane' }),
  ).toThrow(HttpError)
  expect(() =>
    accessRequest({ action: 'deleteUser', name: 'JANE', marker: 'bad', confirmation: 'JANE' }),
  ).toThrow(HttpError)
  expect(
    accessRequest({ action: 'deleteUser', name: 'JANE', marker: id, confirmation: 'JANE' }),
  ).toMatchObject({ action: 'deleteUser', marker: id })
})
it('deletes only a verified managed user and keeps the operation audit', async () => {
  mocks.one.mockResolvedValueOnce(null).mockResolvedValue(user)
  mocks.sf.mockImplementation(async (sql) =>
    sql.startsWith('SHOW USERS') ? [{ name: 'JANE', comment: marker }] : [],
  )
  await runAccessOperation('OWNER', id, {
    action: 'deleteUser',
    name: 'JANE',
    marker: id,
    confirmation: 'JANE',
  })
  expect(mocks.sf.mock.calls.some((c) => c[0] === 'DROP USER "JANE"')).toBe(true)
  expect(
    mocks.query.mock.calls.some((c) => c[0].startsWith('DELETE FROM gallery_access_objects')),
  ).toBe(true)
  expect(
    mocks.query.mock.calls.some((c) => c[0].startsWith('DELETE FROM gallery_access_operations')),
  ).toBe(false)
  expect(mocks.query).toHaveBeenCalledWith(
    "UPDATE events SET archived_account=true,visibility='PRIVATE' WHERE owner_username=$1",
    ['JANE'],
  )
  expect(mocks.query.mock.calls.some(([q]) => q.includes('INSERT INTO deleted_accounts'))).toBe(
    true,
  )
  expect(mocks.query.mock.calls.some(([q]) => q.includes('SET owner_username='))).toBe(false)
  expect(
    mocks.query.mock.calls.some(([q]) => q.startsWith('UPDATE album_public_links SET revoked_at=')),
  ).toBe(true)
  expect(mocks.query).toHaveBeenCalledWith(
    'DELETE FROM album_shares WHERE username=$1 OR event_id IN (SELECT event_id FROM events WHERE owner_username=$1)',
    ['JANE'],
  )
  expect(mocks.query).toHaveBeenCalledWith('DELETE FROM upload_sessions WHERE owner=$1', ['JANE'])
})
it('refuses self deletion, privileged users and stale deletion after recreation', async () => {
  const req = { action: 'deleteUser' as const, name: 'JANE', marker: id, confirmation: 'JANE' }
  mocks.one.mockResolvedValue(null)
  await expect(runAccessOperation('JANE', id, req)).rejects.toMatchObject({ status: 403 })
  mocks.one.mockResolvedValueOnce(null).mockResolvedValue(user)
  mocks.sf.mockImplementation(async (sql) =>
    sql.startsWith('SHOW USERS')
      ? [{ name: 'JANE', comment: marker }]
      : [{ role: 'ACCOUNTADMIN', granted_on: 'ROLE', privilege: 'USAGE' }],
  )
  await expect(runAccessOperation('OWNER', id, req)).rejects.toMatchObject({ status: 409 })
  mocks.one.mockResolvedValueOnce(null).mockResolvedValue({ ...user, marker: 'different' })
  await expect(runAccessOperation('OWNER', id, req)).rejects.toMatchObject({ status: 409 })
  expect(mocks.sf.mock.calls.some((c) => c[0].startsWith('DROP'))).toBe(false)
})
it('finishes deletion when Snowflake drop succeeded before registry cleanup failed', async () => {
  const req = { action: 'deleteUser' as const, name: 'JANE', marker: id, confirmation: 'JANE' }
  mocks.one
    .mockResolvedValueOnce({ actor: 'OWNER', request: req, state: 'failed' })
    .mockResolvedValue(user)
  mocks.sf.mockResolvedValue([])
  await expect(runAccessOperation('OWNER', id, req)).resolves.toMatchObject({
    message: expect.stringContaining('deleted'),
  })
  expect(mocks.sf.mock.calls.some((c) => c[0].startsWith('DROP'))).toBe(false)
  expect(
    mocks.query.mock.calls.some((c) => c[0].startsWith('DELETE FROM gallery_access_objects')),
  ).toBe(true)
})

it('creates Auth0 identity before marking ready and never puts an Auth0 password in Snowflake', async () => {
  auth0.enabled.mockReturnValue(true)
  auth0.ensure.mockResolvedValue('auth0|new')
  mocks.one.mockResolvedValue(null)
  mocks.query.mockImplementation(async (sql) =>
    sql.startsWith('INSERT INTO gallery_access_objects') ? [user] : [],
  )
  await runAccessOperation('OWNER', id, { ...request, password: 'PrivatePassword1234' })
  expect(auth0.ensure).toHaveBeenCalledWith(user, 'PrivatePassword1234')
  expect(mocks.sf.mock.calls.find((c) => c[0].startsWith('CREATE USER'))![0]).not.toContain(
    'PASSWORD=',
  )
  expect(mocks.query.mock.calls.some((c) => c[0].includes('auth0_user_id=$2'))).toBe(true)
  expect(JSON.stringify(mocks.query.mock.calls)).not.toContain('PrivatePassword1234')
})
it('keeps creation pending if Auth0 fails and resumes with the same Snowflake identity', async () => {
  auth0.enabled.mockReturnValue(true)
  auth0.ensure.mockRejectedValue(new HttpError(502, 'Auth0 unavailable'))
  mocks.one.mockResolvedValue(null)
  mocks.query.mockImplementation(async (sql) =>
    sql.startsWith('INSERT INTO gallery_access_objects') ? [user] : [],
  )
  await expect(
    runAccessOperation('OWNER', id, { ...request, password: 'PrivatePassword1234' }),
  ).rejects.toMatchObject({ status: 502 })
  expect(mocks.query.mock.calls.some((c) => c[0].includes("state='ready'"))).toBe(false)
})
it('changes only the verified Auth0 password for connected accounts', async () => {
  auth0.enabled.mockReturnValue(true)
  mocks.one
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ ...user, auth0_user_id: 'auth0|linked' })
  mocks.sf.mockImplementation(async (q) =>
    q.startsWith('SHOW USERS') ? [{ name: 'JANE', comment: marker }] : [],
  )
  await runAccessOperation('OWNER', id, {
    action: 'setPassword',
    name: 'JANE',
    password: 'PrivatePassword1234',
  })
  expect(auth0.password).toHaveBeenCalled()
  expect(mocks.sf.mock.calls.some((c) => c[0].includes('PASSWORD='))).toBe(false)
})
it('validates Auth0 ownership before disabling Snowflake and retains registry on a partial delete', async () => {
  auth0.enabled.mockReturnValue(true)
  auth0.inspect.mockResolvedValue({})
  auth0.delete.mockRejectedValue(new HttpError(502, 'Auth0 unavailable'))
  mocks.one
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ ...user, auth0_user_id: 'auth0|linked' })
  mocks.sf.mockImplementation(async (q) =>
    q.startsWith('SHOW USERS') ? [{ name: 'JANE', comment: marker }] : [],
  )
  await expect(
    runAccessOperation('OWNER', id, {
      action: 'deleteUser',
      name: 'JANE',
      marker: id,
      confirmation: 'JANE',
    }),
  ).rejects.toMatchObject({ status: 502 })
  expect(mocks.sf.mock.calls.some((c) => c[0].includes('DISABLED=TRUE'))).toBe(true)
  expect(mocks.sf.mock.calls.some((c) => c[0].startsWith('DROP'))).toBe(false)
  expect(mocks.query.mock.calls.some((c) => c[0].startsWith('DELETE FROM'))).toBe(false)
})
it('does not disable or delete a user with mismatched Auth0 ownership', async () => {
  auth0.enabled.mockReturnValue(true)
  auth0.inspect.mockRejectedValue(new HttpError(409, 'Mismatch'))
  mocks.one
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ ...user, auth0_user_id: 'auth0|linked' })
  mocks.sf.mockImplementation(async (q) =>
    q.startsWith('SHOW USERS') ? [{ name: 'JANE', comment: marker }] : [],
  )
  await expect(
    runAccessOperation('OWNER', id, {
      action: 'deleteUser',
      name: 'JANE',
      marker: id,
      confirmation: 'JANE',
    }),
  ).rejects.toMatchObject({ status: 409 })
  expect(mocks.sf.mock.calls.some((c) => c[0].startsWith('ALTER') || c[0].startsWith('DROP'))).toBe(
    false,
  )
  expect(auth0.delete).not.toHaveBeenCalled()
})
it('exposes original recovery operation for verified pending accounts', async () => {
  const { accessOverview } = await import('@/lib/access-management')
  const pending = { ...user, state: 'pending' }
  const recovery = {
    id,
    actor: 'OWNER',
    request: { ...request, password: '[REDACTED]' },
    state: 'failed',
  }
  mocks.query.mockImplementation(async (q) =>
    q === 'SELECT * FROM gallery_access_objects ORDER BY created_at DESC' ? [pending] : [],
  )
  mocks.one.mockImplementation(async (q) =>
    q.includes('gallery_access_operations') ? recovery : pending,
  )
  mocks.sf.mockImplementation(async (q) =>
    q.startsWith('SHOW USERS') ? [{ name: 'JANE', comment: marker }] : [],
  )
  const result = await accessOverview()
  expect(result.users[0]).toMatchObject({
    state: 'pending',
    canDelete: true,
    recovery,
    issue: expect.stringContaining('Resume setup'),
  })
  mocks.sf.mockResolvedValue([{ name: 'JANE', comment: 'changed externally' }])
  const unsafe = await accessOverview()
  expect(unsafe.users[0]).toMatchObject({ canDelete: false, recovery: null })
})
it('resumes a rejected Auth0 creation with a replacement password without duplicating Snowflake', async () => {
  const req = { ...request, password: 'StrongerPassword123!' }
  auth0.enabled.mockReturnValue(true)
  auth0.ensure.mockResolvedValue('auth0|new')
  mocks.one
    .mockResolvedValueOnce({
      actor: 'OWNER',
      request: { ...req, password: '[REDACTED]' },
      state: 'failed',
    })
    .mockResolvedValueOnce({ ...user, state: 'pending' })
  mocks.sf.mockResolvedValue([{ name: 'JANE', comment: marker }])
  await runAccessOperation('OWNER', id, req)
  expect(auth0.ensure).toHaveBeenCalledWith(expect.objectContaining({ marker: id }), req.password)
  expect(mocks.sf.mock.calls.some((c) => c[0].startsWith('CREATE USER'))).toBe(false)
  expect(mocks.query.mock.calls.some((c) => c[0].includes("state='ready'"))).toBe(true)
  expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(req.password)
})

const personalGrants = [
  { granted_on: 'DATABASE', name: 'USER$JANE', privilege: 'USAGE' },
  { granted_on: 'DATABASE', name: 'USER$JANE', privilege: 'CREATE SCHEMA' },
  { granted_on: 'SCHEMA', name: 'USER$JANE.LOCAL', privilege: 'OWNERSHIP' },
  { granted_on: 'SCHEMA', name: 'USER$JANE.PUBLIC', privilege: 'OWNERSHIP' },
].map((g) => ({ ...g, role: null, granted_to: 'USER', grantee_name: 'JANE' }))
it('lists the viewer role and allows password management with Snowflake personal database grants', async () => {
  const { accessOverview } = await import('@/lib/access-management')
  auth0.enabled.mockReturnValue(true)
  const linked = { ...user, auth0_user_id: 'auth0|linked' }
  mocks.one.mockImplementation(async (q) => (q.includes('gallery_access_objects') ? linked : null))
  mocks.query.mockImplementation(async (q) =>
    q === 'SELECT * FROM gallery_access_objects ORDER BY created_at DESC' ? [linked] : [],
  )
  mocks.sf.mockImplementation(async (q) =>
    q.startsWith('SHOW USERS')
      ? [{ name: 'JANE', comment: marker }]
      : q.startsWith('SHOW GRANTS TO USER')
        ? [
            ...personalGrants,
            { role: 'PERSONAL_PHOTOS_VIEWER', granted_on: 'ROLE', privilege: 'USAGE' },
          ]
        : [],
  )
  expect((await accessOverview()).users[0]).toMatchObject({
    issue: null,
    roles: ['PERSONAL_PHOTOS_VIEWER'],
  })
  await runAccessOperation('OWNER', id, {
    action: 'setPassword',
    name: 'JANE',
    password: 'PrivatePassword1234',
  })
  expect(auth0.password).toHaveBeenCalledWith(linked, 'PrivatePassword1234')
})
it.each([
  { ...personalGrants[0], name: 'OTHER_DATABASE' },
  { ...personalGrants[0], name: 'USER$OTHER' },
  { ...personalGrants[0], privilege: 'OWNERSHIP' },
  { ...personalGrants[2], name: 'USER$JANE_EXTRA.PUBLIC' },
  { role: null, granted_on: 'WAREHOUSE', name: 'COMPUTE_WH', privilege: 'USAGE' },
  { role: 'ACCOUNTADMIN', granted_on: 'ROLE', privilege: 'USAGE' },
])('blocks non-gallery access even when personal grants are present: %j', async (grant) => {
  mocks.one.mockResolvedValueOnce(null).mockResolvedValue(user)
  mocks.sf.mockImplementation(async (q) =>
    q.startsWith('SHOW USERS')
      ? [{ name: 'JANE', comment: marker }]
      : q.startsWith('SHOW GRANTS TO USER')
        ? [...personalGrants, grant]
        : [],
  )
  await expect(
    runAccessOperation('OWNER', id, {
      action: 'deleteUser',
      name: 'JANE',
      marker: id,
      confirmation: 'JANE',
    }),
  ).rejects.toMatchObject({ status: 409 })
  expect(mocks.sf.mock.calls.some((c) => c[0].startsWith('DROP') || c[0].startsWith('ALTER'))).toBe(
    false,
  )
})

it('falls back to PUBLIC after removing the last role despite personal database grants', async () => {
  mocks.one.mockResolvedValueOnce(null).mockResolvedValue(user)
  mocks.sf.mockImplementation(async (q) =>
    q.startsWith('SHOW USERS')
      ? [{ name: 'JANE', comment: marker }]
      : q.startsWith('SHOW GRANTS TO USER')
        ? personalGrants
        : [],
  )
  await runAccessOperation('OWNER', id, {
    action: 'revokeRole',
    name: 'JANE',
    role: 'PERSONAL_PHOTOS_VIEWER',
  })
  expect(mocks.sf).toHaveBeenCalledWith('ALTER USER "JANE" SET DEFAULT_ROLE=\'PUBLIC\'')
})

vi.mock('../lib/identity/identity-control', () => ({
  identityControl: (action: string, p: any) => mocks.sf(legacyIdentityCommand(action, p)),
}))

it('changes roles and account status in Postgres without Snowflake calls', async () => {
  vi.stubEnv('APP_PERMISSION_AUTHORITY', 'postgres')
  try {
    mocks.one.mockImplementation(async (sql) =>
      sql.includes('gallery_access_objects') ? user : null,
    )
    await runAccessOperation('OWNER', id, {
      action: 'grantRole',
      name: 'JANE',
      role: 'PERSONAL_PHOTOS_VIEWER',
    })
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('photo_security.change_app_permission'),
      [id, 'JANE', id, 'grant', 'viewer'],
    )
    await runAccessOperation('OWNER', id, {
      action: 'setUserEnabled',
      name: 'JANE',
      enabled: false,
    })
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('photo_security.change_app_permission'),
      [id, 'JANE', id, 'enabled', 'false'],
    )
    expect(mocks.sf).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllEnvs()
  }
})
it('creates app-only users with Auth0 and requires an explicit later access grant', async () => {
  vi.stubEnv('APP_PERMISSION_AUTHORITY', 'postgres')
  try {
    auth0.enabled.mockReturnValue(true)
    auth0.ensure.mockResolvedValue('auth0|jane')
    mocks.one.mockResolvedValue(null)
    mocks.query.mockImplementation(async (sql) =>
      sql.startsWith('INSERT INTO gallery_access_objects') ? [user] : [],
    )
    await runAccessOperation('OWNER', id, { ...request, password: 'Test-Only-Password-123' })
    expect(auth0.ensure).toHaveBeenCalled()
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('register_app_principal'), [
      'JANE',
      id,
    ])
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('change_app_permission'))).toBe(
      false,
    )
    expect(mocks.sf).not.toHaveBeenCalled()
    expect(JSON.stringify(mocks.query.mock.calls)).not.toContain('Test-Only-Password-123')
  } finally {
    vi.unstubAllEnvs()
  }
})
it('self-service mode rejects manual account creation and password writes before any side effects', async () => {
  vi.stubEnv('APP_PERMISSION_AUTHORITY', 'postgres')
  vi.stubEnv('CUSTOMER_ACCOUNTS_ENABLED', 'true')
  try {
    await expect(runAccessOperation('OWNER', id, request)).rejects.toMatchObject({ status: 400 })
    await expect(
      runAccessOperation('OWNER', id, {
        action: 'setPassword',
        name: 'JANE',
        password: 'Test-Only-Password-123',
      }),
    ).rejects.toMatchObject({ status: 400 })
    expect(mocks.lock).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(auth0.ensure).not.toHaveBeenCalled()
    expect(auth0.password).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllEnvs()
  }
})
it('lists customer Member/Admin roles from Postgres without requiring Snowflake users', async () => {
  vi.stubEnv('APP_PERMISSION_AUTHORITY', 'postgres')
  vi.stubEnv('CUSTOMER_ACCOUNTS_ENABLED', 'true')
  try {
    const { accessOverview } = await import('@/lib/access-management')
    mocks.query.mockImplementation(async (q) =>
      q.includes('app_access_overview()')
        ? [{ marker: id, enabled: true, roles: ['member', 'administrator'] }]
        : q.startsWith('SELECT * FROM gallery_access_objects')
          ? [user]
          : [],
    )
    const result = await accessOverview()
    expect(result.users[0]).toMatchObject({
      name: 'JANE',
      roles: ['STILLMARK_MEMBER', 'STILLMARK_ADMIN'],
      issue: null,
    })
    expect(result.roles.map((r) => r.display_name)).toEqual(['Member', 'Admin'])
    expect(mocks.sf).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllEnvs()
  }
})
it.each([true, false])(
  'uses current app Admins and preflights deletion before Auth0 (recipient=%s)',
  async (recipientExists) => {
    vi.stubEnv('APP_PERMISSION_AUTHORITY', 'postgres')
    const linked = { ...user, auth0_user_id: 'auth0|jane' }
    try {
      auth0.enabled.mockReturnValue(true)
      mocks.one.mockImplementation(async (sql: string) => {
        if (sql.includes('gallery_access_operations')) return null
        if (sql.includes('CROSS JOIN LATERAL photo_security.native_app_identity'))
          return recipientExists ? { username: 'CURRENT_ADMIN' } : null
        return linked
      })
      const operation = runAccessOperation('CURRENT_ADMIN', id, {
        action: 'deleteUser',
        name: 'JANE',
        marker: id,
        confirmation: 'JANE',
      })
      if (recipientExists) {
        await operation
        expect(auth0.delete).toHaveBeenCalledWith(linked)
        expect(mocks.query).toHaveBeenCalledWith(
          "UPDATE events SET archived_account=true,visibility='PRIVATE' WHERE owner_username=$1",
          ['JANE'],
        )
        expect(
          mocks.one.mock.calls.filter(([q]) =>
            q.includes('CROSS JOIN LATERAL photo_security.native_app_identity'),
          ),
        ).toHaveLength(2)
      } else {
        await expect(operation).rejects.toMatchObject({ status: 409 })
        expect(auth0.delete).not.toHaveBeenCalled()
        expect(mocks.query.mock.calls.some(([q]) => q.includes('SET deleting=true'))).toBe(false)
      }
      expect(mocks.sf).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  },
)

it('retains the permission operation ID through a lost acknowledgement and actor-scoped replay', async () => {
  vi.stubEnv('APP_PERMISSION_AUTHORITY', 'postgres')
  const req = { action: 'grantRole' as const, name: 'JANE', role: 'PERSONAL_PHOTOS_VIEWER' }
  let journal: Record<string, any> | null = null
  let lostAcknowledgement = true
  const permissionCalls: unknown[][] = []
  try {
    mocks.one.mockImplementation(async (sql) =>
      sql.includes('gallery_access_operations') ? journal : user,
    )
    mocks.query.mockImplementation(async (sql, args = []) => {
      if (sql.startsWith('INSERT INTO gallery_access_operations'))
        journal = { actor: args[1], request: JSON.parse(args[2]), state: 'running' }
      if (sql.includes('photo_security.change_app_permission')) {
        permissionCalls.push(args)
        if (lostAcknowledgement) {
          lostAcknowledgement = false
          throw new Error('Committed permission result was lost')
        }
      }
      if (sql.includes("SET state='failed'")) journal!.state = 'failed'
      if (sql.includes("SET state='succeeded'")) {
        journal!.state = 'succeeded'
        journal!.result = JSON.parse(args[1])
      }
      return []
    })
    await expect(runAccessOperation('OWNER', id, req)).rejects.toMatchObject({ status: 502 })
    await expect(runAccessOperation('OWNER', id, req)).resolves.toMatchObject({
      message: 'Gallery role assigned.',
    })
    expect(permissionCalls).toEqual([
      [id, 'JANE', id, 'grant', 'viewer'],
      [id, 'JANE', id, 'grant', 'viewer'],
    ])
    // The PostgreSQL gate separately proves this same ID is applied only once.
    await runAccessOperation('OWNER', id, req)
    await expect(runAccessOperation('OTHER_ADMIN', id, req)).rejects.toMatchObject({ status: 409 })
    expect(permissionCalls).toHaveLength(2)
    expect(mocks.sf).not.toHaveBeenCalled()
    expect(auth0.ensure).not.toHaveBeenCalled()
    expect(
      mocks.query.mock.calls.filter(([sql]) => sql.includes('invalidate_authorization')),
    ).toHaveLength(4)
  } finally {
    vi.unstubAllEnvs()
  }
})
