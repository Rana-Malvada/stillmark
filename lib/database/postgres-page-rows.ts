import { pgQuery } from '../postgres'
import { flagOn } from '../flags'

/** Internal bounded page queries only; parameters and the caller's RLS scope are unchanged. */
export async function pgPageRows<T>(sql: string, params: unknown[]): Promise<T[]> {
  if (!flagOn('PG_JSON_PAGE_ROWS_ENABLED')) return pgQuery<T>(sql, params)
  const result = await pgQuery<{ page_rows: T[] }>(
    `SELECT COALESCE(json_agg(page_rows), '[]'::json) AS page_rows FROM (${sql}) page_rows`,
    params,
  )
  if (!Array.isArray(result[0]?.page_rows)) throw new Error('Invalid database page result')
  return result[0].page_rows
}
