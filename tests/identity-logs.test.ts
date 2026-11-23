import { expect, it, vi } from 'vitest'

vi.mock('@/lib/postgres', () => ({
  pgQuery: vi.fn(),
  pgTransaction: vi.fn(),
  withAdvisoryLock: vi.fn(),
}))
vi.mock('@/lib/snowflake', () => ({ querySnowflake: vi.fn() }))
vi.mock('@/lib/identity/auth0-management', () => ({ readAuth0LogPage: vi.fn() }))
import { auth0Login, identityEventId, snowflakeLogin } from '@/lib/identity/identity-logs'
import { csvCell, exportFilters } from '@/lib/observability/activity-exports'

it('filters other applications and does not attribute attacker-entered names', () => {
  const log = {
    client_id: 'gallery',
    log_id: '123',
    type: 'fp',
    date: new Date().toISOString(),
    user_name: 'ADMIN',
    ip: 'private',
  }
  expect(auth0Login(log, 'other', new Map())).toBeNull()
  expect(auth0Login(log, 'gallery', new Map())).toMatchObject({
    username: '[unmapped Auth0 identity]',
    kind: 'login_failure',
  })
  expect(
    auth0Login({ ...log, user_id: 'auth0|1', type: 's' }, 'gallery', new Map([['auth0|1', 'GH']])),
  ).toMatchObject({ username: 'GH', kind: 'login_success' })
  expect(JSON.stringify(auth0Login(log, 'gallery', new Map()))).not.toContain('private')
  expect(auth0Login({ ...log, type: 'sapi' }, 'gallery', new Map())).toBeNull()
})
it('limits Snowflake history to registered users and separates provider identities', () => {
  const row = {
    USER_NAME: 'GH',
    EVENT_ID: '123',
    IS_SUCCESS: 'YES',
    EVENT_TIMESTAMP: new Date().toISOString(),
    FIRST_AUTHENTICATION_FACTOR: 'SAML2_ASSERTION',
  }
  expect(snowflakeLogin(row, new Set())).toBeNull()
  expect(snowflakeLogin(row, new Set(['GH']))).toMatchObject({
    scope: 'account_not_app',
    provider: 'snowflake',
  })
  expect(identityEventId('auth0', '123')).not.toBe(identityEventId('snowflake', '123'))
  expect(identityEventId('auth0', '123')).toBe(identityEventId('auth0', '123'))
})
it('neutralizes CSV formulas and rejects unbounded exports', () => {
  for (const v of ['=1+1', ' +1', '\t@SUM(1)', '-1']) expect(csvCell(v)).toContain("'")
  expect(csvCell('a"b')).toBe('"a""b"')
  expect(() => exportFilters(new Request('https://app/export?days=91'))).toThrow()
  expect(exportFilters(new Request('https://app/export?mode=summary')).days).toBe(366)
})
