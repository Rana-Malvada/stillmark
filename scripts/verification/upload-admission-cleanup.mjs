/** Exercise the ambiguous-commit cleanup fence on real PostgreSQL connections. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { withLocalPostgres } from './local-postgres.mjs'

await withLocalPostgres('admission-cleanup', async ({ admin, connect }) => {
  await admin.query('CREATE TABLE upload_pool_requests(id uuid PRIMARY KEY,owner text)')
  const registering = await connect()
  const cleaning = await connect()
  for (const outcome of ['COMMIT', 'ROLLBACK']) {
    const id = randomUUID()
    await registering.query('BEGIN')
    await registering.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id])
    await registering.query('INSERT INTO upload_pool_requests VALUES($1,$2)', [id, 'ALICE'])
    await cleaning.query('BEGIN')
    let finished = false
    const fence = cleaning
      .query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id])
      .then(() => {
        finished = true
      })
    let blocked = false
    for (let i = 0; i < 100; i++) {
      if (
        (await admin.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [cleaning.processID]))
          .rows[0].n
      ) {
        blocked = true
        break
      }
      await delay(10)
    }
    assert.ok(blocked, 'Cleanup must wait for the registering transaction')
    assert.equal(finished, false)
    await registering.query(outcome)
    await fence
    const removed = await cleaning.query(
      'DELETE FROM upload_pool_requests WHERE id=$1 AND owner=$2',
      [id, 'ALICE'],
    )
    assert.equal(removed.rowCount, outcome === 'COMMIT' ? 1 : 0)
    await cleaning.query('COMMIT')
    assert.equal(
      (await admin.query('SELECT count(*)::int AS n FROM upload_pool_requests')).rows[0].n,
      0,
    )
  }
  console.log(
    'PASS: cleanup waits for ambiguous admission commit/rollback, then removes only the settled request; no leaked busy records',
  )
})
