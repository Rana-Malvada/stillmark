#!/usr/bin/env node
// Read-only pooled-connection checks; run separately from the permission mutation suite.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import pg from 'pg'

const owner = process.env.LOAD_TEST_OWNER
const eventId = Number(process.env.LOAD_TEST_EVENT_ID)
assert.match(process.env.PGDATABASE ?? '', /^stillmark_loadtest_[a-z0-9_]+$/)
assert.equal(process.env.PGPORT, '5431')
assert.equal(process.env.PGUSER, 'personal_photos_app')
assert.match(owner ?? '', /^STILLMARK_LOADTEST_[A-Z0-9_]+$/)
assert.ok(Number.isSafeInteger(eventId) && eventId > 0)
const pool = new pg.Pool({
  max: 24,
  connectionTimeoutMillis: 10000,
  query_timeout: 10000,
  statement_timeout: 30000,
  ssl: { ca: await readFile(process.env.PGSSLROOTCERT, 'utf8'), rejectUnauthorized: true },
})
try {
  // Same startup options as the deployed app; ignored startup timeout must be
  // replaced by the enforced role default, not accidentally disabled.
  const settings = (
    await pool.query(
      "SELECT current_setting('statement_timeout') timeout, current_setting('work_mem') memory",
    )
  ).rows[0]
  assert.equal(settings.timeout, '30s')
  assert.equal(settings.memory, '4MB')
  const clients = await Promise.all(Array.from({ length: 24 }, () => pool.connect()))
  const backendIds = new Set()
  try {
    for (let round = 0; round < 3; round++) {
      await Promise.all(
        clients.map(async (client, i) => {
          await client.query('BEGIN')
          // A new transaction must never inherit the previous tenant or SET LOCAL ROLE.
          const clean = (
            await client.query(
              "SELECT current_user role, coalesce(current_setting('photos.username',true),'') identity",
            )
          ).rows[0]
          assert.equal(clean.role, 'personal_photos_app')
          assert.equal(clean.identity, '')
          await client.query(
            "SELECT set_config('photos.username',$1,true),set_config('photos.main_admin','false',true),set_config('photos.admin_read','false',true)",
            [owner],
          )
          assert.equal(
            (await client.query('SELECT event_id FROM events WHERE event_id=$1', [eventId]))
              .rowCount,
            1,
          )
          await client.query('SET LOCAL ROLE personal_photos_reader')
          const a = (await client.query('SELECT pg_backend_pid() pid')).rows[0].pid
          await client.query('SELECT pg_sleep(0.01)')
          assert.equal((await client.query('SELECT pg_backend_pid() pid')).rows[0].pid, a)
          backendIds.add(a)
          await client.query(i % 2 ? 'COMMIT' : 'ROLLBACK')
        }),
      )
    }
  } finally {
    for (const c of clients) c.release()
  }
  assert.ok(
    backendIds.size < clients.length,
    'Expected virtual clients to share fewer physical backends',
  )
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await c.query("SET LOCAL statement_timeout='50ms'")
    await assert.rejects(c.query('SELECT pg_sleep(0.2)'), { code: '57014' })
    await c.query('ROLLBACK')
    assert.equal((await c.query('SHOW statement_timeout')).rows[0].statement_timeout, '30s')
  } finally {
    c.release()
  }
  console.log(
    JSON.stringify({
      passed: true,
      clients: clients.length,
      physicalBackends: backendIds.size,
      settings,
      identityReset: true,
      roleReset: true,
      backendPinnedWithinTransaction: true,
      serverTimeoutEnforced: true,
    }),
  )
} finally {
  await pool.end()
}
