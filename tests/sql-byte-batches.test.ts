import { expect, it } from 'vitest'
import { sqlByteBatches } from '@/lib/sql-byte-batches'

const sql = (values: string[]) => `VALUES ${values.join(',\n')}`
it('counts UTF-8 and wrappers, preserves rows and enforces the exact byte ceiling', () => {
  const rows = ['éé', 'abc', '🦊', 'last']
  const batches = sqlByteBatches(rows, (x) => x, sql, 16)
  expect(batches.flatMap((b) => b.records)).toEqual(rows)
  expect(batches).toHaveLength(3)
  for (const batch of batches) expect(Buffer.byteLength(batch.sql)).toBeLessThanOrEqual(16)
})
it('fails oversized single records without dropping or truncating them', () => {
  expect(() => sqlByteBatches(['ok', 'x'.repeat(20)], (x) => x, sql, 16)).toThrow(
    'nothing was truncated',
  )
  expect(sqlByteBatches([], (x: string) => x, sql, 16)).toEqual([])
})
