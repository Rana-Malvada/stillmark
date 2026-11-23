/** Local authorization/concurrency correctness check; no remote database or media. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { withLocalPostgres } from './local-postgres.mjs'

const upload = '00000000-0000-4000-8000-000000000011'
const otherUpload = '00000000-0000-4000-8000-000000000012'
const completed = '00000000-0000-4000-8000-000000000013'
const token = '00000000-0000-4000-8000-000000000021'

await withLocalPostgres('upload-authority', async ({ admin, connect, clients, imageId }) => {
  await admin.query(
    readFileSync(
      new URL('../../tests/fixtures/upload-account-authority.sql', import.meta.url),
      'utf8',
    ),
  )
  await admin.query('BEGIN')
  await admin.query(
    readFileSync(
      new URL(
        '../../migrations/postgres/202611081510_upload_account_authority.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  await admin.query('COMMIT')
  let publisher = await connect('personal_photos_app')
  const deleter = await connect('personal_photos_app')
  const unrelated = await connect('personal_photos_app')
  const begin = async (client, owner = 'ALICE') => {
    await client.query('BEGIN')
    await client.query("SELECT set_config('photos.username',$1,true)", [owner])
  }
  const allowed = async (client, owner = 'ALICE') =>
    (await client.query('SELECT photo_security.upload_account_allowed($1) AS allowed', [owner]))
      .rows[0].allowed
  const remove = (client) => client.query('SELECT photo_security.request_account_deletion()')
  async function reset() {
    await admin.query(`TRUNCATE upload_sessions,upload_processing_jobs,upload_chunks,stage_cleanup,album_public_links,catalog;
      UPDATE photo_security.customer_accounts SET deletion_requested_at=NULL;
      UPDATE photo_security.app_principals SET enabled=true;
      INSERT INTO upload_sessions VALUES('${upload}','ALICE',NULL,'${token}',now()+interval '5 minutes'),
        ('${otherUpload}','BOB',NULL,'${token}',now()+interval '5 minutes'),
        ('${completed}','ALICE','{"eventId":7}',NULL,NULL);
      INSERT INTO upload_processing_jobs VALUES('${upload}','ALICE','processing','${token}',now()+interval '5 minutes'),
        ('${otherUpload}','BOB','queued',NULL,NULL),('${completed}','ALICE','done',NULL,NULL);
      INSERT INTO upload_chunks VALUES('${upload}','upload-chunks/${upload}/part');
      INSERT INTO stage_cleanup(path) VALUES('upload-chunks/${upload}/part');
      INSERT INTO album_public_links(owner_username) VALUES('ALICE'),('BOB');`)
  }
  async function waitForLock(client) {
    // The backend PID is available without issuing another query on the blocked client.
    for (let i = 0; i < 100; i++) {
      const r = await admin.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [
        client.processID,
      ])
      if (r.rows[0].n > 0) return
      await delay(10)
    }
    throw Error('Account operation did not reach the expected transaction fence')
  }
  async function publish(client) {
    assert.equal(await allowed(client), true)
    assert.equal(
      (
        await client.query(
          'SELECT upload_id FROM upload_processing_jobs WHERE upload_id=$1 AND lease_token=$2 FOR UPDATE',
          [upload, token],
        )
      ).rowCount,
      1,
    )
    assert.equal(
      (
        await client.query(
          'SELECT upload_id FROM upload_sessions WHERE upload_id=$1 AND result IS NULL FOR UPDATE',
          [upload],
        )
      ).rowCount,
      1,
    )
    await client.query('INSERT INTO catalog VALUES($1)', [upload])
    await client.query('UPDATE upload_sessions SET result=$2 WHERE upload_id=$1', [
      upload,
      { eventId: 8 },
    ])
    await client.query(
      "UPDATE upload_processing_jobs SET state='done',lease_token=NULL,lease_until=NULL WHERE upload_id=$1",
      [upload],
    )
  }
  const settled = (promise) =>
    promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
  const unwrap = async (promise) => {
    const result = await promise
    if (result.error) throw result.error
    return result.value
  }

  await reset()
  await begin(deleter)
  await remove(deleter)
  await begin(publisher)
  const deletedFirst = settled(allowed(publisher))
  await waitForLock(publisher)
  await begin(unrelated, 'BOB')
  assert.equal(await allowed(unrelated, 'BOB'), true)
  await unrelated.query('COMMIT')
  await deleter.query('COMMIT')
  assert.equal(await unwrap(deletedFirst), false)
  await publisher.query('ROLLBACK')
  assert.equal(
    (await admin.query('SELECT * FROM upload_processing_jobs WHERE upload_id=$1', [upload]))
      .rowCount,
    0,
  )
  assert.equal((await admin.query('SELECT * FROM upload_chunks')).rowCount, 0)
  assert.equal((await admin.query('SELECT * FROM stage_cleanup')).rowCount, 1)
  assert.equal(
    (
      await admin.query('SELECT * FROM upload_sessions WHERE upload_id=$1 AND result IS NOT NULL', [
        completed,
      ])
    ).rowCount,
    1,
  )
  assert.equal(
    (await admin.query('SELECT * FROM upload_processing_jobs WHERE upload_id=$1', [otherUpload]))
      .rowCount,
    1,
  )
  assert.equal(
    (
      await admin.query(
        'SELECT * FROM album_public_links WHERE owner_username=$1 AND revoked_at IS NULL',
        ['ALICE'],
      )
    ).rowCount,
    0,
  )
  console.log(
    'PASS deletion-first fences stale publication, cancels pending work, retains cleanup/replay and does not block another owner',
  )

  await reset()
  await begin(publisher)
  await publish(publisher)
  await begin(deleter)
  const publishedFirst = settled(remove(deleter))
  await waitForLock(deleter)
  await publisher.query('COMMIT')
  await unwrap(publishedFirst)
  await deleter.query('COMMIT')
  assert.equal((await admin.query('SELECT * FROM catalog')).rowCount, 1)
  assert.equal(
    (
      await admin.query('SELECT * FROM upload_sessions WHERE upload_id=$1 AND result IS NOT NULL', [
        upload,
      ])
    ).rowCount,
    1,
  )
  console.log('PASS publication-first commits before deletion; completed media and replay survive')

  await reset()
  await begin(publisher)
  await publish(publisher)
  await begin(deleter)
  const interrupted = settled(remove(deleter))
  await waitForLock(deleter)
  await publisher.end()
  clients.delete(publisher)
  await unwrap(interrupted)
  await deleter.query('COMMIT')
  assert.equal((await admin.query('SELECT * FROM catalog')).rowCount, 0)
  assert.equal(
    (await admin.query('SELECT * FROM upload_sessions WHERE upload_id=$1', [upload])).rowCount,
    0,
  )
  publisher = await connect('personal_photos_app')
  console.log(
    'PASS worker disconnect rolls back publication and releases the account fence for deletion',
  )

  await reset()
  await begin(deleter)
  await remove(deleter)
  await begin(publisher)
  const rollback = settled(allowed(publisher))
  await waitForLock(publisher)
  await deleter.query('ROLLBACK')
  assert.equal(await unwrap(rollback), true)
  await publish(publisher)
  await publisher.query('COMMIT')
  assert.equal((await admin.query('SELECT * FROM catalog')).rowCount, 1)
  console.log('PASS rolled-back deletion preserves authority and processing recovery')

  await reset()
  await begin(publisher)
  assert.equal(await allowed(publisher, 'BOB'), false)
  await publisher.query('ROLLBACK')
  const queue = await connect('personal_photos_upload_queue')
  await assert.rejects(queue.query('SELECT photo_security.upload_account_allowed($1)', ['ALICE']), {
    code: '42501',
  })
  console.log('PASS account scope and restricted queue credentials cannot borrow upload authority')
  console.log(
    JSON.stringify({
      postgres: (await admin.query('SHOW server_version')).rows[0].server_version,
      image: imageId,
      productionChanges: 0,
      mediaCalls: 0,
    }),
  )
})
