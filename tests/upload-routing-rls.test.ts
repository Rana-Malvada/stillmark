import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('migration keeps routing admin-controlled and request records owner-scoped', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE ROLE personal_photos_app;CREATE ROLE personal_photos_maintenance;
   CREATE SCHEMA photo_security;
   CREATE FUNCTION photo_security.username() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('photos.username',true),'') $$;
   CREATE FUNCTION photo_security.flag(n text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('photos.'||n,true),'false')='true' $$;
   GRANT USAGE ON SCHEMA photo_security,public TO personal_photos_app,personal_photos_maintenance;`)
    await db.exec(readFileSync('migrations/postgres/202610242230_upload_routing.sql', 'utf8'))
    await db.exec('CREATE TABLE upload_processing_jobs(id int, state text)')
    await db.exec(readFileSync('migrations/postgres/202611011800_upload_pool_idle.sql', 'utf8'))
    await db.exec("UPDATE upload_routing SET last_activity_at='2000-01-01'")
    await db.exec("UPDATE upload_processing_jobs SET state='processing' WHERE false")
    expect(
      (
        await db.query<{ old: boolean }>(
          "SELECT last_activity_at='2000-01-01'::timestamptz AS old FROM upload_routing",
        )
      ).rows[0].old,
    ).toBe(true)
    await db.exec("INSERT INTO upload_processing_jobs VALUES(1,'queued')")
    expect(
      (
        await db.query<{ old: boolean }>(
          "SELECT last_activity_at='2000-01-01'::timestamptz AS old FROM upload_routing",
        )
      ).rows[0].old,
    ).toBe(false)
    await db.exec('SET ROLE personal_photos_app')
    expect((await db.query('SELECT * FROM upload_routing')).rows).toHaveLength(0)
    await db.exec(
      "SELECT set_config('photos.username','ALICE',false),set_config('photos.can_write','true',false)",
    )
    expect((await db.query('SELECT route FROM upload_routing')).rows).toEqual([{ route: 'pool' }])
    await expect(db.exec("UPDATE upload_routing SET route='app'")).rejects.toThrow()
    await db.exec(
      "INSERT INTO upload_pool_requests(id,owner) VALUES('00000000-0000-4000-8000-000000000001','ALICE')",
    )
    await expect(
      db.exec(
        "INSERT INTO upload_pool_requests(id,owner) VALUES('00000000-0000-4000-8000-000000000002','BOB')",
      ),
    ).rejects.toThrow(/row-level security/)
    await db.exec("SELECT set_config('photos.username','BOB',false)")
    expect((await db.query('DELETE FROM upload_pool_requests RETURNING id')).rows).toHaveLength(0)
    await db.exec('RESET ROLE;SET ROLE personal_photos_maintenance')
    expect((await db.query('SELECT * FROM upload_pool_requests')).rows).toHaveLength(1)
    await expect(
      db.exec("UPDATE upload_routing SET route='app',desired='app',phase='draining'"),
    ).rejects.toThrow()
  } finally {
    await db.close()
  }
}, 30000)
