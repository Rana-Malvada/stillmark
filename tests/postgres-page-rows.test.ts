import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@/lib/postgres', () => ({
  pgQuery: async (sql: string, params: unknown[]) => (await state.db.query(sql, params)).rows,
}))
import { pgPageRows } from '@/lib/database/postgres-page-rows'

beforeAll(async () => {
  state.db = new PGlite()
  await state.db.waitReady
})
afterAll(async () => {
  await state.db.close()
})
afterEach(() => vi.unstubAllEnvs())
it('preserves bounded page order, types, nulls and parameterized strings', async () => {
  const sql = `SELECT n::int AS id, (n%2=0) AS favorite, CASE WHEN n%2=0 THEN NULL ELSE $1::text END AS caption, n::float8/3 AS ratio FROM generate_series(1,100) n WHERE n>$2 ORDER BY n DESC LIMIT 97`
  const params = ["quoted '; SELECT secret -- 🖼", 1]
  vi.stubEnv('PG_JSON_PAGE_ROWS_ENABLED', 'false')
  const regular = await pgPageRows(sql, params)
  vi.stubEnv('PG_JSON_PAGE_ROWS_ENABLED', 'true')
  expect(await pgPageRows(sql, params)).toEqual(regular)
  expect(regular).toHaveLength(97)
})
it('returns an empty page and propagates SQL failures', async () => {
  vi.stubEnv('PG_JSON_PAGE_ROWS_ENABLED', 'true')
  expect(await pgPageRows('SELECT 1 WHERE false', [])).toEqual([])
  await expect(pgPageRows('SELECT 1/0', [])).rejects.toThrow()
})
