import { createTestDatabase } from './fixtures/test-database'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'

let db: PGlite
const ids = Array.from({ length: 7 }, () => randomUUID())
const names = ['OWNER', 'OTHER_OWNER', 'VIEWER', 'READONLY', 'MANAGER', 'NONE', 'DISABLED']
beforeAll(async () => {
  db = await createTestDatabase({
    roles: [
      'snowflake_admin',
      'personal_photos_app NOINHERIT',
      'personal_photos_reader',
      'personal_photos_video_worker',
    ],
    steps: [
      {
        sql: 'SET search_path=public;GRANT USAGE ON SCHEMA public TO personal_photos_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO personal_photos_app;GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO personal_photos_app;',
      },
      'setup/72-app-rls.sql',
      '202610062030_gateway_security',
      '202610280100_app_permissions',
      '202610280110_app_permission_cardinality',
      '202610280130_gateway_cleanup_index_cutoff',
    ],
  })
  for (let i = 0; i < names.length; i++) {
    await db.query(
      "INSERT INTO gallery_access_objects(kind,name,marker,display_name,created_by,state,auth0_user_id) VALUES('user',$1,$2,$1,'test','ready',$3)",
      [names[i], ids[i], 'auth0|' + names[i]],
    )
    await db.query('INSERT INTO photo_security.app_principals(marker,enabled) VALUES($1,$2)', [
      ids[i],
      i !== 6,
    ])
  }
  for (const [i, role] of [
    [0, 'app_owner'],
    [1, 'app_owner'],
    [2, 'viewer'],
    [3, 'admin_readonly'],
    [4, 'viewer'],
    [4, 'access_manager'],
    [6, 'viewer'],
  ] as const)
    await db.query('INSERT INTO photo_security.app_memberships(marker,role_key) VALUES($1,$2)', [
      ids[i],
      role,
    ])
}, 30000)
afterAll(async () => db?.close())
async function acting(who: string, fn: () => Promise<void>) {
  await db.exec('BEGIN;SET LOCAL ROLE personal_photos_app')
  try {
    await db.query("SELECT set_config('photos.username',$1,true)", [who])
    await fn()
    await db.exec('COMMIT')
  } catch (e) {
    await db.exec('ROLLBACK')
    throw e
  }
}
async function identity(i: number, sid = randomUUID(), jti = randomUUID()) {
  return (
    await db.query<any>('SELECT * FROM photo_security.gateway_app_identity_once($1,$2,$3,$4)', [
      'auth0|' + names[i],
      sid,
      jti,
      Math.floor(Date.now() / 1000) + 30,
    ])
  ).rows
}
async function change(i: number, action: string, value: string, op = randomUUID()) {
  await db.query('SELECT photo_security.change_app_permission($1,$2,$3,$4,$5)', [
    op,
    names[i],
    ids[i],
    action,
    value,
  ])
}
it('returns exact roles, disabled state, and denies access when no grant exists', async () => {
  await acting('VIEWER', async () => {
    expect((await identity(2))[0]).toMatchObject({
      app_role: 'viewer',
      app_owner: false,
      can_manage_personal: true,
      can_manage_access: false,
      enabled: true,
    })
    expect((await identity(3))[0]).toMatchObject({
      app_role: 'admin_readonly',
      can_manage_personal: false,
    })
    expect((await identity(5))[0].app_role).toBeNull()
    expect((await identity(6))[0].enabled).toBe(false)
  })
})
it('keeps assertion replay protection and immediate session revocation', async () => {
  const sid = randomUUID()
  const jti = randomUUID()
  await acting('VIEWER', async () => {
    expect(await identity(2, sid, jti)).toHaveLength(1)
    expect(await identity(2, sid, jti)).toHaveLength(0)
  })
  await db.query(
    "INSERT INTO gallery_revoked_sessions(sid,expires_at) VALUES($1,now()+interval '1 hour')",
    [sid],
  )
  await acting('VIEWER', async () => {
    expect((await identity(2, sid))[0].revoked).toBe(true)
  })
})
it('cannot read or modify authority tables directly or grant as a viewer', async () => {
  for (const table of ['app_principals', 'app_roles', 'app_memberships', 'app_permission_audit'])
    await expect(
      acting('VIEWER', async () => {
        await db.query('SELECT * FROM photo_security.' + table)
      }),
    ).rejects.toThrow(/permission denied/)
  await expect(acting('VIEWER', () => change(5, 'grant', 'admin'))).rejects.toThrow(
    /Access manager/,
  )
  await expect(acting('MANAGER', () => change(5, 'grant', 'app_owner'))).rejects.toThrow(
    /App owner/,
  )
  await expect(acting('OWNER', () => change(0, 'revoke', 'app_owner'))).rejects.toThrow(
    /Self access/,
  )
})
it('makes grants, revocation and disable atomic, audited and immediately visible', async () => {
  const op = randomUUID()
  await acting('OWNER', () => change(5, 'grant', 'viewer', op))
  await acting('OWNER', () => change(5, 'grant', 'viewer', op))
  expect((await identity(5))[0]).toMatchObject({ app_role: 'viewer', epoch: 2 })
  expect(
    (
      await db.query('SELECT * FROM photo_security.app_permission_audit WHERE operation_id=$1', [
        op,
      ])
    ).rows,
  ).toHaveLength(1)
  await expect(acting('OWNER', () => change(5, 'grant', 'admin', op))).rejects.toThrow(
    /Operation ID conflict/,
  )
  await acting('OWNER', () => change(5, 'enabled', 'false'))
  expect((await identity(5))[0].enabled).toBe(false)
  await acting('OWNER', () => change(5, 'enabled', 'true'))
  await acting('OWNER', () => change(5, 'revoke', 'viewer'))
  expect((await identity(5))[0].app_role).toBeNull()
})
it('does not let an old registry marker grant access to a recreated account', async () => {
  await db.query('DELETE FROM gallery_access_objects WHERE marker=$1', [ids[6]])
  const replacement = randomUUID()
  await db.query(
    "INSERT INTO gallery_access_objects(kind,name,marker,display_name,created_by,state,auth0_user_id) VALUES('user',$1,$2,$1,'test','ready',$3)",
    [names[6], replacement, 'auth0|' + names[6]],
  )
  expect((await identity(6))[0].enabled).toBeNull()
  await expect(acting('OWNER', () => change(6, 'grant', 'viewer'))).rejects.toThrow(
    /registry mismatch/,
  )
})
it('rechecks a revoked manager against current database state', async () => {
  await acting('OWNER', () => change(4, 'revoke', 'access_manager'))
  await expect(acting('MANAGER', () => change(5, 'grant', 'viewer'))).rejects.toThrow(
    /Access manager/,
  )
})

it('declares single-row identity cardinality to avoid inflated JIT plans', async () => {
  const result = await db.query<{ proname: string; prorows: number }>(
    "SELECT proname,prorows FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='photo_security' AND proname IN ('app_permission_snapshot','native_app_identity','gateway_app_identity_once')",
  )
  expect(result.rows).toHaveLength(3)
  expect(result.rows.every((r) => Number(r.prorows) === 1)).toBe(true)
})

it('cleans only expired claims and retains live replay protection', async () => {
  const expired = randomUUID()
  const live = randomUUID()
  await db.query(
    "INSERT INTO photo_security.gateway_assertions VALUES($1,now()-interval '1 minute'),($2,now()+interval '1 minute')",
    [expired, live],
  )
  await acting('VIEWER', async () => {
    expect(await identity(2)).toHaveLength(1)
  })
  const remaining = await db.query<{ jti: string }>(
    'SELECT jti FROM photo_security.gateway_assertions WHERE jti=ANY($1::uuid[])',
    [[expired, live]],
  )
  expect(remaining.rows).toEqual([{ jti: live }])
  await acting('VIEWER', async () => {
    expect(await identity(2, randomUUID(), live)).toEqual([])
  })
})

it('saved-search replay can validate current accounts without legacy users access', async () => {
  await acting('VIEWER', async () => {
    for (const [name, count] of [
      ['VIEWER', 1],
      ['DISABLED', 0],
      ['NONE', 0],
      ['MISSING', 0],
    ] as const) {
      const result = await db.query(
        `SELECT name FROM photo_security.native_app_identity($1)
        WHERE enabled AND NOT revoked AND app_role IS NOT NULL`,
        [name],
      )
      expect(result.rows).toHaveLength(count)
    }
  })
})
