import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'

vi.mock('@/lib/postgres', () => ({ pgQueryOne: vi.fn() }))
import { acquireCoordinatorSql } from '@/lib/database/background-coordinator'

it('elects one scheduler, recovers an expired lease, and preserves replay protection', async () => {
  const db = new PGlite()
  const a = '00000000-0000-4000-8000-000000000001'
  const b = '00000000-0000-4000-8000-000000000002'
  try {
    await db.exec(`CREATE ROLE personal_photos_app;CREATE ROLE personal_photos_maintenance;CREATE SCHEMA photo_security;
      GRANT USAGE ON SCHEMA photo_security TO personal_photos_app;
      CREATE FUNCTION photo_security.username() RETURNS text LANGUAGE sql AS $$SELECT 'ALICE'::text$$;
      CREATE FUNCTION photo_security.flag(text) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
      CREATE FUNCTION photo_security.gateway_identity(text,uuid) RETURNS TABLE(name text,marker uuid,revoked boolean) LANGUAGE sql AS $$SELECT 'ALICE'::text,'${a}'::uuid,false$$;
      CREATE TABLE upload_sessions(upload_id uuid,result jsonb,expires_at timestamptz);
      CREATE TABLE upload_processing_jobs(upload_id uuid);`)
    await db.exec(readFileSync('migrations/postgres/202610062030_gateway_security.sql', 'utf8'))
    await db.exec(
      readFileSync('migrations/postgres/202610290210_background_coordination.sql', 'utf8'),
    )
    await db.exec('SET ROLE personal_photos_maintenance')
    await expect(db.query('SELECT photo_security.cleanup_gateway_assertions()')).rejects.toThrow(
      /permission denied for schema/,
    )
    await db.exec('RESET ROLE')
    await db.exec(
      readFileSync('migrations/postgres/202610290220_assertion_cleanup_schema_access.sql', 'utf8'),
    )
    await db.exec('SET ROLE personal_photos_maintenance')
    expect((await db.query(acquireCoordinatorSql, [a])).rows).toHaveLength(1)
    expect((await db.query(acquireCoordinatorSql, [b])).rows).toHaveLength(0)
    await db.exec("UPDATE background_coordinator SET lease_until=now()-interval '1 second'")
    expect((await db.query(acquireCoordinatorSql, [b])).rows).toHaveLength(1)
    expect((await db.query(acquireCoordinatorSql, [a])).rows).toHaveLength(0)
    await db.exec('RESET ROLE;SET ROLE personal_photos_app')
    await expect(db.query(acquireCoordinatorSql, [a])).rejects.toThrow(/permission denied/)
    await expect(db.query('SELECT photo_security.cleanup_gateway_assertions()')).rejects.toThrow(
      /permission denied/,
    )
    const args = ['subject', a, b, Math.floor(Date.now() / 1000) + 30]
    const sql = 'SELECT * FROM photo_security.gateway_identity_once($1,$2,$3,$4)'
    expect((await db.query(sql, args)).rows).toHaveLength(1)
    expect((await db.query(sql, args)).rows).toHaveLength(0)
    await db.exec('RESET ROLE')
    await db.exec(
      `INSERT INTO photo_security.gateway_assertions VALUES('${a}',now()-interval '1 minute')`,
    )
    await db.exec('SET ROLE personal_photos_maintenance')
    expect(
      (await db.query<{ n: number }>('SELECT photo_security.cleanup_gateway_assertions() AS n'))
        .rows[0].n,
    ).toBe(1)
    await db.exec('RESET ROLE;SET ROLE personal_photos_app')
    expect((await db.query(sql, args)).rows).toHaveLength(0)
  } finally {
    await db.close()
  }
})
