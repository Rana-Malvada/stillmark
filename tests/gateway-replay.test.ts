import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it.each([false, true])(
  'atomically consumes assertions, expires them, and restricts cache invalidation (indexed=%s)',
  async (indexed) => {
    const db = new PGlite()
    try {
      await db.exec(`CREATE ROLE personal_photos_app; CREATE SCHEMA photo_security;
 GRANT USAGE ON SCHEMA photo_security TO personal_photos_app;
 CREATE FUNCTION photo_security.flag(text) RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(current_setting('photos.access_manager',true),'false')='true'$$;
 CREATE FUNCTION photo_security.gateway_identity(text,uuid) RETURNS TABLE(name text,marker uuid,revoked boolean) LANGUAGE sql AS $$SELECT 'ALICE'::text,'00000000-0000-0000-0000-000000000001'::uuid,false$$;`)
      await db.exec(readFileSync('migrations/postgres/202610062030_gateway_security.sql', 'utf8'))
      if (indexed)
        await db.exec(
          readFileSync('migrations/postgres/202610280130_gateway_cleanup_index_cutoff.sql', 'utf8'),
        )
      await db.exec('SET ROLE personal_photos_app')
      const args = [
        'auth0|a',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        Math.floor(Date.now() / 1000) + 30,
      ]
      const sql = 'SELECT * FROM photo_security.gateway_identity_once($1,$2::uuid,$3::uuid,$4)'
      const claims = await Promise.all([db.query(sql, args), db.query(sql, args)])
      expect(claims.map((x) => x.rows.length).sort()).toEqual([0, 1])
      expect(
        (await db.query(sql, [...args.slice(0, 2), '00000000-0000-0000-0000-000000000003', 1]))
          .rows,
      ).toHaveLength(0)
      await expect(db.query('SELECT * FROM photo_security.gateway_assertions')).rejects.toThrow()
      await db.query('SELECT photo_security.invalidate_authorization()')
      expect(
        (await db.query<{ v: number }>('SELECT photo_security.authorization_epoch() AS v')).rows[0]
          .v,
      ).toBe(1)
      await db.exec("SET photos.access_manager='true'")
      await db.query('SELECT photo_security.invalidate_authorization()')
      expect(
        (await db.query<{ v: number }>('SELECT photo_security.authorization_epoch() AS v')).rows[0]
          .v,
      ).toBe(2)
      await db.exec('RESET ROLE')
      await db.query(
        "UPDATE photo_security.gateway_assertions SET expires_at=now()-interval '1 minute'",
      )
      await db.query(sql, [
        ...args.slice(0, 2),
        '00000000-0000-0000-0000-000000000004',
        Math.floor(Date.now() / 1000) + 30,
      ])
      expect((await db.query('SELECT * FROM photo_security.gateway_assertions')).rows).toHaveLength(
        1,
      )
    } finally {
      await db.close()
    }
  },
)
