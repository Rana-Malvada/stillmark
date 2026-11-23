import assert from 'node:assert/strict'
import { withLocalPostgres } from './local-postgres.mjs'

await withLocalPostgres('album-locks', async ({ connect }) => {
  const a = await connect()
  const b = await connect()
  const catalog = await connect()
  const shared = "SELECT pg_advisory_xact_lock_shared(hashtextextended('photo-management',0))"
  await a.query('BEGIN')
  await a.query(shared)
  await a.query('SELECT pg_advisory_xact_lock(1)')
  await b.query('BEGIN')
  await b.query(shared)
  assert.equal(
    (await b.query('SELECT pg_try_advisory_xact_lock(2) AS acquired')).rows[0].acquired,
    true,
  )
  assert.equal(
    (await b.query('SELECT pg_try_advisory_xact_lock(1) AS acquired')).rows[0].acquired,
    false,
  )
  await catalog.query('BEGIN')
  assert.equal(
    (
      await catalog.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('photo-management',0)) AS acquired",
      )
    ).rows[0].acquired,
    false,
  )
  await a.query('COMMIT')
  await b.query('COMMIT')
  assert.equal(
    (
      await catalog.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('photo-management',0)) AS acquired",
      )
    ).rows[0].acquired,
    true,
  )
  await a.query('BEGIN')
  assert.equal(
    (
      await a.query(
        "SELECT pg_try_advisory_xact_lock_shared(hashtextextended('photo-management',0)) AS acquired",
      )
    ).rows[0].acquired,
    false,
  )
  await catalog.query('COMMIT')
  await a.query('ROLLBACK')
  console.log(
    'PASS PostgreSQL locks: unrelated albums progress; same album serializes; catalog changes exclude scoped writers in both directions',
  )
})
