import { expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import {
  searchUpdateChainSql,
  searchUpdateChildSql,
  searchUpdatePlan,
} from '@/lib/search/search-update'

it('records a recoverable continuation atomically and retains the first deadline across three jobs', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE TABLE search_batch_runs(id text PRIMARY KEY, status text DEFAULT 'completed', requested_by text, photo_limit int, search_limit int, photos_done int DEFAULT 0, elapsed_ms int DEFAULT 0, created_at timestamptz DEFAULT clock_timestamp(), continued_by text REFERENCES search_batch_runs(id), pipeline_error text, automatic_photo_ids int[]);
    INSERT INTO search_batch_runs(id,photo_limit,search_limit,photos_done,created_at) VALUES('root',10000,20,4000,'2026-11-20 10:00:00Z')`)
    await db.query(searchUpdateChildSql, ['second', 'owner', 6000, 20, 'root'])
    await db.exec("UPDATE search_batch_runs SET photos_done=3000 WHERE id='second'")
    await db.query(searchUpdateChildSql, ['third', 'owner', 3000, 20, 'second'])
    const { rows } = await db.query<any>(searchUpdateChainSql, ['third'])
    const plan = searchUpdatePlan(rows, 3000, Date.parse('2026-11-20 12:00:00Z'))
    expect(plan).toMatchObject({
      photosDone: 7000,
      remaining: 3000,
      expired: false,
      deadline: Date.parse('2026-11-20 13:00:00Z'),
    })
    expect(searchUpdatePlan(rows, 3000, plan.deadline).expired).toBe(true)
    await db.exec("UPDATE search_batch_runs SET status='cancelled' WHERE id='third'")
    expect(
      (await db.query(searchUpdateChildSql, ['cancelled-child', 'owner', 3000, 20, 'third'])).rows,
    ).toEqual([])
    expect(
      (await db.query("SELECT id FROM search_batch_runs WHERE id='cancelled-child'")).rows,
    ).toEqual([])
    await db.exec("UPDATE search_batch_runs SET status='completed' WHERE id='third'")
    // Failed insertion cannot leave a partially linked parent.
    await expect(
      db.query(searchUpdateChildSql, ['second', 'owner', 3000, 20, 'third']),
    ).rejects.toThrow()
    expect(
      (await db.query<any>("SELECT continued_by FROM search_batch_runs WHERE id='third'")).rows[0]
        .continued_by,
    ).toBeNull()
  } finally {
    await db.close()
  }
})
it('does not extend a requested photo cap to cover later uploads', () => {
  const root = { photo_limit: 100, photos_done: 80, created_at: new Date().toISOString() }
  expect(searchUpdatePlan([root], 10000).remaining).toBe(20)
})
