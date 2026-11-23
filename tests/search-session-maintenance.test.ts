import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'
import {
  pruneExpiredSearchSessionsSql,
  pruneViewerSearchSessionsSql,
  shouldTouchSearchSession,
} from '@/lib/search/search-session-maintenance'

it('coalesces repeated cache-hit writes without using popularity for authorization', () => {
  expect(shouldTouchSearchSession(new Date(10000), 69999)).toBe(false)
  expect(shouldTouchSearchSession(new Date(10000), 70000)).toBe(true)
})
it('bounds retention work and preserves the most recent fifty sessions', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE TABLE search_sessions(id int PRIMARY KEY,expires_at timestamptz,last_used_at timestamptz);
    INSERT INTO search_sessions SELECT i,now()+interval '1 day',now()+(i*interval '1 second') FROM generate_series(1,300) i;`)
    await db.exec(pruneViewerSearchSessionsSql)
    expect(
      (await db.query<{ n: number }>('SELECT count(*)::int n FROM search_sessions')).rows[0].n,
    ).toBe(250)
    expect((await db.query('SELECT id FROM search_sessions WHERE id>250')).rows).toHaveLength(50)
    await db.exec(
      `TRUNCATE search_sessions; INSERT INTO search_sessions SELECT i,now()-interval '1 day',now() FROM generate_series(1,600) i;`,
    )
    await db.exec(pruneExpiredSearchSessionsSql)
    expect(
      (await db.query<{ n: number }>('SELECT count(*)::int n FROM search_sessions')).rows[0].n,
    ).toBe(100)
  } finally {
    await db.close()
  }
})
