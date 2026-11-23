import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { withLocalPostgres } from './local-postgres.mjs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const source = read('../../lib/search/search-sync-ack.ts')
const statement = (name) => source.match(new RegExp(`export const ${name} = \x60([^\x60]+)\x60`))[1]
const claim = statement('claimPhotosSql')
const ack = statement('acknowledgePhotosSql')
await withLocalPostgres('search-delete-cleanup', async ({ admin, connect }) => {
  await admin.query(read('./gallery-statistics-fixture.sql'))
  for (const migration of [
    '202610311200_gallery_statistics',
    '202611101600_cancel_unpublished_search_deletes',
  ]) {
    await admin.query('BEGIN')
    await admin.query(read(`../../migrations/postgres/${migration}.sql`))
    await admin.query('COMMIT')
  }
  await admin.query('DELETE FROM photos; DELETE FROM search_queue')
  const publisher = await connect()
  const deleter = await connect()
  async function blocked(client) {
    for (let i = 0; i < 100; i++) {
      const { rows } = await admin.query('SELECT cardinality(pg_blocking_pids($1)) n', [
        client.processID,
      ])
      if (rows[0].n > 0) return
      await delay(10)
    }
    throw new Error('Expected real PostgreSQL lock contention was not observed')
  }
  async function reconcile() {
    const { rows } = await admin.query(`SELECT
      (SELECT count(*)::int FROM search_queue WHERE kind='photo' AND operation='remove') actual,
      (SELECT coalesce(sum(photo_removals),0)::int FROM gallery_statistics WHERE scope='all') projected`)
    assert.equal(rows[0].actual, rows[0].projected)
  }
  for (let round = 0; round < 10; round++) {
    const id = 1000 + round
    await admin.query('INSERT INTO photos(photo_id,event_id) VALUES($1,1)', [id])
    // Publisher wins: deletion must wait on the committed claim, then keep removal.
    await publisher.query('BEGIN')
    const sent = (await publisher.query(claim)).rows.find((r) => r.id === id)
    const deletion = deleter.query('DELETE FROM photos WHERE photo_id=$1', [id])
    deletion.catch(() => {})
    await blocked(deleter)
    await publisher.query('COMMIT')
    await deletion
    await publisher.query(ack, [[id], [sent.revision], [id]])
    const removal = (
      await admin.query("SELECT revision FROM search_queue WHERE kind='photo' AND id=$1", [id])
    ).rows[0]
    assert.ok(removal, 'stale publication acknowledgment lost the deletion')
    await publisher.query(ack, [[id], [removal.revision], []])
    await reconcile()
    // Deletion wins: a publisher whose statement started while deletion was
    // uncommitted must return no claim after waiting, not publish the removed row.
    await admin.query('INSERT INTO photos(photo_id,event_id) VALUES($1,1)', [id])
    await deleter.query('BEGIN')
    await deleter.query('DELETE FROM photos WHERE photo_id=$1', [id])
    const publishing = publisher.query(claim)
    publishing.catch(() => {})
    await blocked(publisher)
    await deleter.query('COMMIT')
    assert.equal((await publishing).rows.length, 0)
    assert.equal((await admin.query('SELECT * FROM search_queue')).rowCount, 0)
    await reconcile()
    // Rolled-back claim never reached the remote write: deletion may cancel it.
    await admin.query('INSERT INTO photos(photo_id,event_id) VALUES($1,1)', [id])
    await publisher.query('BEGIN')
    await publisher.query(claim)
    const afterRollback = deleter.query('DELETE FROM photos WHERE photo_id=$1', [id])
    afterRollback.catch(() => {})
    await blocked(deleter)
    await publisher.query('ROLLBACK')
    await afterRollback
    assert.equal((await admin.query('SELECT * FROM search_queue')).rowCount, 0)
    await reconcile()
  }
  console.log(
    'PASS: 30 real PostgreSQL lock-contention races; no lost removals or phantom cleanup counts',
  )
})
