import { expect, it } from 'vitest'
import { scopedReadStatement } from '../lib/postgres-scoped-read.mjs'

it('escapes values without rescanning inserted placeholders or changing quoted SQL', () => {
  const sql = scopedReadStatement(
    "SELECT $1::text,'$2' AS literal,$2::boolean",
    ["x'; COMMIT; SELECT '$2' --\\", false],
    { username: "O'BRIEN\\", mainAdmin: false },
    true,
  )
  expect(sql).toContain("'$2' AS literal,false::boolean")
  expect(sql).toContain('BEGIN READ ONLY; SET LOCAL ROLE personal_photos_reader')
  expect(sql).toContain('SET LOCAL jit=off')
  expect(sql.endsWith('; COMMIT;')).toBe(true)
})
it('rejects multiple statements, unsupported values and absent parameters before checkout', () => {
  for (const sql of ['DELETE FROM photos', 'SELECT 1; RESET ROLE', 'SELECT $2', 'SELECT /* x */ 1'])
    expect(() => scopedReadStatement(sql, [1], { username: 'alice', mainAdmin: false })).toThrow()
  for (const value of [NaN, Infinity, {}, ['a'], '\0'])
    expect(() =>
      scopedReadStatement('SELECT $1', [value], { username: 'alice', mainAdmin: false }),
    ).toThrow()
})
