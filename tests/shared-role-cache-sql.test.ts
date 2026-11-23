import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('restricts table access and bounds the SQL cache lifetime', async () => {
  const db = new PGlite()
  try {
    await db.exec(
      'CREATE SCHEMA photo_security; CREATE ROLE personal_photos_app; GRANT USAGE ON SCHEMA photo_security TO personal_photos_app;',
    )
    await db.exec(readFileSync('migrations/postgres/202610260140_shared_role_cache.sql', 'utf8'))
    await db.exec(
      readFileSync('migrations/postgres/202610270400_role_cache_nonblocking_cleanup.sql', 'utf8'),
    )
    await db.exec('SET ROLE personal_photos_app')
    await expect(db.query('SELECT * FROM photo_security.role_cache')).rejects.toThrow(
      'permission denied',
    )
    const key = 'b'.repeat(64)
    await db.query('SELECT photo_security.write_role_cache($1,$2,$3)', [
      key,
      'signed-envelope',
      Date.now() + 30_000,
    ])
    expect(
      (await db.query('SELECT photo_security.read_role_cache($1) AS result', [key])).rows[0],
    ).toEqual({ result: 'signed-envelope' })
    await db.query('SELECT photo_security.write_role_cache($1,$2,$3)', [
      key,
      'too-long',
      Date.now() + 120_000,
    ])
    expect(
      (await db.query('SELECT photo_security.read_role_cache($1) AS result', [key])).rows[0],
    ).toEqual({ result: 'signed-envelope' })
    await db.exec(
      "RESET ROLE; UPDATE photo_security.role_cache SET expires_at=now()-interval '1 second'; SET ROLE personal_photos_app;",
    )
    expect(
      (await db.query('SELECT photo_security.read_role_cache($1) AS result', [key])).rows[0],
    ).toEqual({ result: null })
    const replacement = 'c'.repeat(64)
    await db.query('SELECT photo_security.write_role_cache($1,$2,$3)', [
      replacement,
      'fresh',
      Date.now() + 30_000,
    ])
    await db.exec('RESET ROLE')
    expect((await db.query('SELECT cache_key FROM photo_security.role_cache')).rows).toEqual([
      { cache_key: replacement },
    ])
  } finally {
    await db.close()
  }
})
