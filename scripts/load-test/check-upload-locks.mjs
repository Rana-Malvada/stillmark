#!/usr/bin/env node
// Run only against an explicitly selected isolated database. No catalog writes.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import pg from 'pg'

if (
  !process.env.PGHOST ||
  !process.env.PGUSER ||
  !/^stillmark_loadtest_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '')
)
  throw Error('Explicit isolated Postgres connection required')
const source = await readFile(new URL('../../lib/upload/ingest-upload.ts', import.meta.url), 'utf8')
const shared = source.match(
  /"(SELECT pg_advisory_xact_lock_shared\(hashtextextended\('photo-management',0\)\))"/g,
)
assert.equal(
  shared?.length,
  2,
  'Both existing-album validation and publication must use the shared barrier',
)
const sharedSql = JSON.parse(shared[0])
const exclusiveSql = "SELECT pg_advisory_xact_lock(hashtextextended('photo-management',0))"
const clients = []
try {
  for (let i = 0; i < 3; i++) {
    const c = new pg.Client({
      connectionTimeoutMillis: 10000,
      statement_timeout: 3000,
      ssl: process.env.PGSSLROOTCERT
        ? { ca: await readFile(process.env.PGSSLROOTCERT, 'utf8'), rejectUnauthorized: true }
        : undefined,
    })
    await c.connect()
    clients.push(c)
    assert.equal((await c.query('SELECT current_database() db')).rows[0].db, process.env.PGDATABASE)
  }
  const [a, b, c] = clients
  const begin = (x) => x.query("BEGIN; SET LOCAL lock_timeout='200ms'")
  const blocked = async (client, sql) => {
    await begin(client)
    await assert.rejects(client.query(sql), { code: '55P03' })
    await client.query('ROLLBACK')
  }
  await begin(a)
  await a.query(sharedSql)
  await a.query('SELECT pg_advisory_xact_lock(700000001::bigint)')
  await begin(b)
  await b.query(sharedSql)
  await b.query('SELECT pg_advisory_xact_lock(700000002::bigint)')
  await blocked(c, 'SELECT pg_advisory_xact_lock(700000001::bigint)')
  await blocked(c, exclusiveSql)
  await a.query('ROLLBACK')
  await b.query('ROLLBACK')
  await begin(c)
  await c.query(exclusiveSql)
  await blocked(a, sharedSql)
  await c.query('ROLLBACK')
  await begin(a)
  await a.query(sharedSql)
  await a.query('ROLLBACK')
  console.log(
    'PASS: independent albums overlap; same-album publication serializes; management excludes uploads in both directions; rollback releases locks',
  )
} finally {
  await Promise.all(clients.map((c) => c.end()))
}
