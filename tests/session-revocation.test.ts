import { createTestDatabase } from './fixtures/test-database'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'

// Exercises the production revocation and identity functions under the application
// role and row security. Nothing here is mocked.
let db: PGlite
const marker = randomUUID()
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
      '202611180900_remembered_sessions',
    ],
  })
  await db.query(
    "INSERT INTO gallery_access_objects(kind,name,marker,display_name,created_by,state,auth0_user_id) VALUES('user','MEMBER',$1,'Member','test','ready','auth0|MEMBER')",
    [marker],
  )
  await db.query('INSERT INTO photo_security.app_principals(marker) VALUES($1)', [marker])
  await db.query(
    "INSERT INTO photo_security.app_memberships(marker,role_key) VALUES($1,'viewer')",
    [marker],
  )
}, 30000)
afterAll(async () => db?.close())

/** Each call is one request: the application role in its own transaction. */
async function app<T>(work: () => Promise<T>) {
  await db.exec('BEGIN;SET LOCAL ROLE personal_photos_app')
  try {
    const result = await work()
    await db.exec('COMMIT')
    return result
  } catch (error) {
    await db.exec('ROLLBACK')
    throw error
  }
}
const revoked = (sid: string) =>
  app(
    async () =>
      (
        await db.query<{ revoked: boolean }>(
          'SELECT revoked FROM photo_security.gateway_app_identity_once($1,$2,$3,$4)',
          ['auth0|MEMBER', sid, randomUUID(), Math.floor(Date.now() / 1000) + 30],
        )
      ).rows[0].revoked,
  )
const revoke = (sid: string) =>
  app(() => db.query('SELECT photo_security.revoke_session($1::uuid)', [sid]))

it('a committed logout rejects every later request of that session and no other', async () => {
  const sid = randomUUID()
  const other = randomUUID()
  expect(await revoked(sid)).toBe(false)
  await revoke(sid)
  // Logout is idempotent: a retried request must not fail or shorten the revocation.
  await revoke(sid)
  for (let request = 0; request < 20; request++) expect(await revoked(sid)).toBe(true)
  expect(await revoked(other)).toBe(false)
  expect(
    (await db.query('SELECT count(*)::int AS n FROM gallery_revoked_sessions WHERE sid=$1', [sid]))
      .rows,
  ).toEqual([{ n: 1 }])
})

it('revocation outlasts the longest remembered session', async () => {
  const sid = randomUUID()
  await revoke(sid)
  const { rows } = await db.query<{ days: number }>(
    'SELECT extract(epoch FROM expires_at-now())/86400 AS days FROM gallery_revoked_sessions WHERE sid=$1',
    [sid],
  )
  expect(Number(rows[0].days)).toBeGreaterThan(30)
})

it('the application role cannot read, forge, shorten or remove a revocation directly', async () => {
  const sid = randomUUID()
  await revoke(sid)
  expect(
    await app(async () => (await db.query('SELECT * FROM gallery_revoked_sessions')).rows),
  ).toEqual([])
  await app(() => db.query('DELETE FROM gallery_revoked_sessions WHERE sid=$1', [sid]))
  await app(() =>
    db.query("UPDATE gallery_revoked_sessions SET expires_at=now()-interval '1 day' WHERE sid=$1", [
      sid,
    ]),
  )
  await expect(
    app(() => db.query('INSERT INTO gallery_revoked_sessions(sid) VALUES($1)', [randomUUID()])),
  ).rejects.toThrow(/row-level security/)
  expect(await revoked(sid)).toBe(true)
})

it('an expired revocation no longer applies and is removed by a later logout', async () => {
  const expired = randomUUID()
  await db.query(
    "INSERT INTO gallery_revoked_sessions(sid,expires_at) VALUES($1,now()-interval '1 minute')",
    [expired],
  )
  expect(await revoked(expired)).toBe(false)
  await revoke(randomUUID())
  expect(
    (
      await db.query('SELECT count(*)::int AS n FROM gallery_revoked_sessions WHERE sid=$1', [
        expired,
      ])
    ).rows,
  ).toEqual([{ n: 0 }])
})
