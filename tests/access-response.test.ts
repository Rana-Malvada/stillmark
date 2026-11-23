import { describe, expect, it } from 'vitest'
import { isAccessOverview, isAccessResult } from '../lib/identity/access-response'
import { readClientResponse } from '../lib/client-response'

const request = {
  action: 'createUser',
  name: 'JANE',
  displayName: 'Jane',
  email: 'jane@example.com',
  password: '[REDACTED]',
}
const operation = { id: 'op', actor: 'OWNER', request, state: 'failed', error: null }
const overview = {
  auth0Enabled: true,
  customerAccountsEnabled: true,
  permissionAuthority: 'postgres',
  refreshedAt: '2026-11-22T00:00:00.000Z',
  users: [
    {
      name: 'JANE',
      marker: 'id',
      display_name: 'Jane',
      email: null,
      state: 'pending',
      roles: [],
      issue: 'Incomplete',
      recovery: operation,
    },
  ],
  roles: [{ name: 'MEMBER', display_name: 'Member', profile: 'viewer', state: 'ready' }],
  operations: [{ ...operation, created_at: '2026-11-22T00:00:00.000Z' }],
}
describe('access API browser contracts', () => {
  it('accepts current permissions and pending recovery without inventing recovery timestamps', () => {
    expect(isAccessOverview(overview)).toBe(true)
    expect(
      isAccessOverview({
        ...overview,
        users: [],
        roles: [],
        operations: [],
        permissionAuthority: 'snowflake',
      }),
    ).toBe(true)
  })
  it('rejects malformed pages and nested fields that render or enable mutations', () => {
    for (const value of [
      null,
      {},
      [],
      { ...overview, users: {} },
      { ...overview, roles: null },
      { ...overview, users: [{ ...overview.users[0], roles: 'ADMIN' }] },
      { ...overview, users: [{ ...overview.users[0], enabled: 'true' }] },
      {
        ...overview,
        users: [
          {
            ...overview.users[0],
            recovery: { ...operation, request: { name: 'JANE', action: 'unexpected' } },
          },
        ],
      },
      { ...overview, roles: [{ ...overview.roles[0], display_name: {} }] },
      {
        ...overview,
        operations: [{ ...operation, request: { action: 'grantRole', name: 'JANE' } }],
      },
    ]) {
      expect(isAccessOverview(value)).toBe(false)
    }
  })
  it('supports every persisted action including redacted credentials', () => {
    for (const request of [
      { action: 'createUser', name: 'JANE', displayName: 'Jane', email: 'jane@example.com' },
      { action: 'createRole', name: 'TEAM', displayName: 'Team', profile: 'viewer' },
      { action: 'setPassword', name: 'JANE', password: '[REDACTED]' },
      { action: 'setUserEnabled', name: 'JANE', enabled: false },
      { action: 'grantRole', name: 'JANE', role: 'MEMBER' },
      { action: 'revokeRole', name: 'JANE', role: 'MEMBER' },
      { action: 'setupLink', name: 'JANE' },
      { action: 'deleteUser', name: 'JANE', marker: 'id', confirmation: 'JANE' },
    ])
      expect(
        isAccessOverview({ ...overview, operations: [{ ...overview.operations[0], request }] }),
      ).toBe(true)
  })
  it('requires literal string profiles in roles, audit requests and pending recovery', () => {
    for (const profile of ['viewer', 'admin', 'admin_readonly', 'app_owner']) {
      const roleOverview = (value: unknown) => ({
        ...overview,
        roles: [{ ...overview.roles[0], profile: value }],
      })
      const roleRequest = (value: unknown) => ({
        action: 'createRole',
        name: 'TEAM',
        displayName: 'Team',
        profile: value,
      })
      const auditOverview = (value: unknown) => ({
        ...overview,
        operations: [{ ...overview.operations[0], request: roleRequest(value) }],
      })
      const recoveryOverview = (value: unknown) => ({
        ...overview,
        users: [{ ...overview.users[0], recovery: { ...operation, request: roleRequest(value) } }],
      })
      for (const page of [roleOverview, auditOverview, recoveryOverview]) {
        expect(isAccessOverview(page(profile))).toBe(true)
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
          'unknown',
        ])
          expect(isAccessOverview(page(value))).toBe(false)
      }
    }
  })
  it('accepts only supported string permission authorities or an omitted legacy authority', () => {
    expect(isAccessOverview({ ...overview, permissionAuthority: undefined })).toBe(true)
    for (const permissionAuthority of ['postgres', 'snowflake']) {
      expect(isAccessOverview({ ...overview, permissionAuthority })).toBe(true)
      for (const value of [
        [permissionAuthority],
        [[permissionAuthority]],
        { value: permissionAuthority },
        { toString: () => permissionAuthority },
        new String(permissionAuthority),
        Object.create(null),
        null,
        0,
        true,
        'unknown',
      ])
        expect(isAccessOverview({ ...overview, permissionAuthority: value })).toBe(false)
    }
  })
  it('accepts success messages and only the supported setup-link destination', () => {
    expect(isAccessResult({ message: 'Done' })).toBe(true)
    expect(
      isAccessResult({
        message: 'Share privately',
        setupUrl: 'https://account.snowflakecomputing.com/session/password-reset?token=synthetic',
      }),
    ).toBe(true)
    for (const setupUrl of [
      'javascript:alert(1)',
      'https://snowflakecomputing.com.attacker.invalid/',
      'https://user:pass@account.snowflakecomputing.com/',
      'http://account.snowflakecomputing.com/',
    ]) {
      expect(isAccessResult({ message: 'Done', setupUrl })).toBe(false)
    }
    expect(isAccessResult({})).toBe(false)
  })
  it('turns malformed200 into a controlled failure and preserves denied status for cache clearing', async () => {
    await expect(
      readClientResponse(new Response('{}'), 'Unable to load access', isAccessOverview),
    ).rejects.toMatchObject({ status: 200 })
    for (const status of [401, 403, 404]) {
      await expect(
        readClientResponse(
          new Response('<html>Denied</html>', { status }),
          'Unable to load access',
          isAccessOverview,
        ),
      ).rejects.toMatchObject({ status, message: 'Unable to load access' })
    }
  })
})
