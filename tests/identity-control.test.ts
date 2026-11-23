import { expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const sf = vi.hoisted(() => vi.fn())
vi.mock('@/lib/snowflake', () => ({ querySnowflake: sf }))
import { identityControl } from '@/lib/identity/identity-control'

const body = readFileSync('setup/identity/control.js', 'utf8')
const marker = '11111111-1111-4111-8111-111111111111'
function execute(
  action: string,
  p: Record<string, unknown>,
  overrides: Record<string, unknown[]> = {},
) {
  const commands: string[] = []
  const base = 'PERSONAL_PHOTOS_VIEWER'
  const owner = 'PERSONAL_PHOTOS_IDENTITY_OWNER'
  const defaults: Record<string, unknown[]> = {
    "SHOW USERS LIKE 'ALICE'": [
      {
        name: 'ALICE',
        owner,
        comment: 'Personal Photos managed access ' + marker,
        disabled: false,
      },
    ],
    [`SHOW ROLES LIKE '${base}'`]: [{ name: base, owner }],
    'SHOW GRANTS TO USER "ALICE"': [{ granted_on: 'ROLE', privilege: 'USAGE', role: base }],
  }
  const snowflake = {
    createStatement: ({ sqlText: q }: { sqlText: string }) => {
      commands.push(q)
      const rows = overrides[q] ?? defaults[q] ?? []
      const keys = Object.keys(rows[0] ?? {})
      let pos = -1
      return {
        getColumnCount: () => keys.length,
        getColumnName: (i: number) => keys[i - 1],
        execute: () => ({
          next: () => ++pos < rows.length,
          getColumnValue: (i: number) => (rows[pos] as any)[keys[i - 1]],
        }),
      }
    },
  }
  const run = () =>
    runInNewContext('(function(){' + body + '})()', {
      ACTION: action,
      PAYLOAD: JSON.stringify(p),
      snowflake,
    })
  return { run, commands }
}
it('uses one bound fixed CALL, never embeds names or passwords in SQL', async () => {
  sf.mockResolvedValue([{ GALLERY_IDENTITY_CONTROL: [] }])
  const payload = { name: 'ALICE', password: "PrivatePass1234'" }
  await identityControl('setPassword', payload)
  expect(sf).toHaveBeenCalledWith('CALL PERSONAL_MEDIA.IDENTITY.GALLERY_IDENTITY_CONTROL(?, ?)', {
    binds: ['setPassword', JSON.stringify(payload)],
  })
})
it('migration embeds the exact independently tested handler', () => {
  expect(readFileSync('setup/62-identity-control.sql', 'utf8')).toContain(body)
})
it.each([
  'ACCOUNTADMIN',
  'SECURITYADMIN',
  'PERSONAL_PHOTOS_RUNTIME',
  'PERSONAL_PHOTOS_IDENTITY_OWNER',
])('rejects privilege escalation to %s', (role) => {
  const x = execute('grantRole', { name: 'ALICE', role })
  expect(x.run).toThrow()
  expect(x.commands.some((q) => q.startsWith('GRANT'))).toBe(false)
})
it.each(['executeSQL', 'dropRole', 'alterPolicy', 'grantPrivilege'])(
  'rejects unsupported operation %s',
  (action) => {
    const x = execute(action, { name: 'ALICE', sql: 'GRANT ACCOUNTADMIN' })
    expect(x.run).toThrow()
    expect(x.commands).toEqual([])
  },
)
it('rejects malformed identifiers before querying and never adopts another owner’s user', () => {
  expect(execute('deleteUser', { name: 'ALICE"; DROP USER EXAMPLEADMIN', marker }).run).toThrow()
  const x = execute(
    'deleteUser',
    { name: 'ALICE', marker },
    {
      "SHOW USERS LIKE 'ALICE'": [
        {
          name: 'ALICE',
          owner: 'ACCOUNTADMIN',
          comment: 'Personal Photos managed access ' + marker,
        },
      ],
    },
  )
  expect(x.run).toThrow()
  expect(x.commands.some((q) => q.startsWith('DROP'))).toBe(false)
})
it('rejects externally expanded base roles before assigning them', () => {
  const x = execute(
    'grantRole',
    { name: 'ALICE', role: 'PERSONAL_PHOTOS_VIEWER' },
    {
      'SHOW GRANTS TO ROLE "PERSONAL_PHOTOS_VIEWER"': [
        { granted_on: 'ACCOUNT', privilege: 'MANAGE GRANTS', name: 'ACCOUNT' },
      ],
    },
  )
  expect(x.run).toThrow()
  expect(x.commands.some((q) => q.startsWith('GRANT'))).toBe(false)
})
it('rejects non-gallery user grants and stale incarnation markers before destructive actions', () => {
  const x = execute(
    'deleteUser',
    { name: 'ALICE', marker },
    {
      'SHOW GRANTS TO USER "ALICE"': [
        { granted_on: 'WAREHOUSE', privilege: 'USAGE', name: 'COMPUTE_WH' },
      ],
    },
  )
  expect(x.run).toThrow()
  expect(x.commands.some((q) => q.startsWith('DROP'))).toBe(false)
  expect(
    execute('deleteUser', { name: 'ALICE', marker: '22222222-2222-4222-8222-222222222222' }).run,
  ).toThrow()
})
it('forces new users into the blocked direct-login policy and grants no role automatically', () => {
  const x = execute('createUser', {
    name: 'TEST_USER',
    marker,
    email: 'a@example.com',
    displayName: "A'B",
  })
  x.run()
  expect(x.commands.at(-1)).toContain('NETWORK_POLICY=PERSONAL_PHOTOS_NO_DIRECT_LOGIN')
  expect(x.commands.at(-1)).toContain("DISPLAY_NAME='A''B'")
  expect(x.commands.some((q) => q.startsWith('GRANT'))).toBe(false)
})
it('permits only gallery role assignment to a managed account', () => {
  const x = execute('grantRole', { name: 'ALICE', role: 'PERSONAL_PHOTOS_VIEWER' })
  x.run()
  expect(x.commands.at(-1)).toBe('GRANT ROLE "PERSONAL_PHOTOS_VIEWER" TO USER "ALICE"')
})
it('does not expose properties of unmanaged users', () => {
  const x = execute(
    'findUser',
    { name: 'ALICE' },
    {
      "SHOW USERS LIKE 'ALICE'": [
        {
          name: 'ALICE',
          owner: 'ACCOUNTADMIN',
          comment: 'private',
          disabled: false,
          email: 'private@example.com',
        },
      ],
    },
  )
  expect(x.run()).toEqual([{ name: 'ALICE', comment: null, disabled: true }])
})
it('reads current identity metadata with SHOW only and returns no unrelated fields', async () => {
  sf.mockReset()
  sf.mockResolvedValue([
    { name: 'ALICE', comment: 'marker', disabled: false, email: 'private@example.com' },
    { name: 'OTHER', comment: 'other' },
  ])
  expect(await identityControl('findUser', { name: 'ALICE' })).toEqual([
    { name: 'ALICE', comment: 'marker', disabled: false },
  ])
  expect(sf).toHaveBeenCalledWith("SHOW USERS LIKE 'ALICE'")
  expect(sf.mock.calls.some((c) => String(c[0]).startsWith('CALL'))).toBe(false)
  await expect(identityControl('findUser', { name: "ALICE'; DROP USER X" })).rejects.toMatchObject({
    status: 403,
  })
  expect(sf).toHaveBeenCalledTimes(1)
})
it('validates inherited base roles before granting App Owner', () => {
  const owner = 'PERSONAL_PHOTOS_IDENTITY_OWNER'
  const x = execute(
    'grantRole',
    { name: 'ALICE', role: 'PERSONAL_PHOTOS_APP_OWNER' },
    {
      "SHOW ROLES LIKE 'PERSONAL_PHOTOS_APP_OWNER'": [{ name: 'PERSONAL_PHOTOS_APP_OWNER', owner }],
      'SHOW GRANTS TO ROLE "PERSONAL_PHOTOS_APP_OWNER"': [
        { granted_on: 'ROLE', privilege: 'USAGE', name: 'PERSONAL_PHOTOS_ADMIN' },
      ],
      "SHOW ROLES LIKE 'PERSONAL_PHOTOS_ADMIN'": [{ name: 'PERSONAL_PHOTOS_ADMIN', owner }],
      'SHOW GRANTS TO ROLE "PERSONAL_PHOTOS_ADMIN"': [
        { granted_on: 'ACCOUNT', privilege: 'CREATE USER', name: 'ACCOUNT' },
      ],
    },
  )
  expect(x.run).toThrow()
  expect(x.commands.some((q) => q.startsWith('GRANT'))).toBe(false)
})
