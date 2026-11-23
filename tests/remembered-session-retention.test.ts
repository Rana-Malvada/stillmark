import { expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

test('logout revocations outlive remembered sessions without changing existing records', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE TABLE gallery_revoked_sessions(sid uuid PRIMARY KEY, expires_at timestamptz NOT NULL DEFAULT (now()+interval '12 hours 5 minutes'));
      INSERT INTO gallery_revoked_sessions(sid) VALUES('11111111-1111-4111-8111-111111111111');`)
    await db.exec(
      'BEGIN;' +
        readFileSync('migrations/postgres/202611180900_remembered_sessions.sql', 'utf8') +
        'COMMIT;',
    )
    await db.exec(
      `INSERT INTO gallery_revoked_sessions(sid) VALUES('22222222-2222-4222-8222-222222222222');`,
    )
    const { rows } = await db.query<{ sid: string; seconds: number }>(
      `SELECT sid, extract(epoch FROM expires_at-now())::float8 AS seconds FROM gallery_revoked_sessions ORDER BY sid`,
    )
    expect(rows[0].seconds).toBeLessThan(13 * 3600)
    expect(rows[1].seconds).toBeGreaterThan(30 * 86400)
    expect(rows[1].seconds).toBeLessThanOrEqual(30 * 86400 + 300)
  } finally {
    await db.close()
  }
})
