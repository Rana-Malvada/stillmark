import { expect, it } from 'vitest'
import {
  readTransactionStart,
  requestTransactionStart,
} from '@/lib/database/postgres-transaction-start'

it('quotes apostrophes, backslashes and SQL-looking identity text as one literal', () => {
  const sql = readTransactionStart({ username: "x'; COMMIT; --\\y", mainAdmin: false })
  expect(sql).toContain("set_config('photos.username', E'x''; COMMIT; --\\\\y',true)")
  expect(sql).toContain("set_config('photos.main_admin','false',true)")
})
it('rejects NUL instead of allowing a truncated identity', () => {
  expect(() => readTransactionStart({ username: 'alice\0admin', mainAdmin: false })).toThrow()
})
it('sets every authorization field transaction-locally, including clearing absent identity', () => {
  const sql = requestTransactionStart(null, 'a'.repeat(64))
  expect(sql).toContain("set_config('photos.username','',true)")
  for (const name of ['main_admin', 'admin_read', 'admin_write', 'can_write', 'access_manager'])
    expect(sql).toContain(`set_config('photos.${name}','false',true)`)
  expect(sql).toContain(`set_config('photos.public_hash','${'a'.repeat(64)}',true)`)
})
