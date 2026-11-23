import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { databaseMonitor, monitorConfig } from './database-monitor.mjs'

class Client extends EventEmitter {
  connections = 0
  queries = 0
  ended = false
  async connect() {
    this.connections++
  }
  async query(sql) {
    assert.equal(sql, 'fixed snapshot')
    return { rows: [{ snapshot: { n: ++this.queries } }] }
  }
  async end() {
    this.ended = true
  }
}
test('reuses one monitoring connection and closes it', async () => {
  const c = new Client()
  const m = databaseMonitor(c, 'fixed snapshot')
  for (let n = 1; n <= 5; n++) assert.deepEqual(await m.snapshot(), { n })
  assert.equal(c.connections, 1)
  await m.close()
  assert.equal(c.ended, true)
})
test('does not hide or retry a monitoring transport failure', async () => {
  const c = new Client()
  const m = databaseMonitor(c, 'fixed snapshot')
  await m.snapshot()
  const error = new Error('lost connection')
  c.emit('error', error)
  await assert.rejects(m.snapshot(), (e) => e === error)
  assert.equal(c.connections, 1)
  assert.equal(c.queries, 1)
  await m.close()
})
test('rejects production database names and unverified TLS', () => {
  assert.throws(() => monitorConfig({ PGDATABASE: 'postgres' }), /Isolated/)
  assert.throws(
    () => monitorConfig({ PGDATABASE: 'stillmark_loadtest_test', PGSSLMODE: 'require' }),
    /Verified/,
  )
})
