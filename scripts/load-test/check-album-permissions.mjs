#!/usr/bin/env node
// Real app-role checks. Every fixture permission mutation is rolled back.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'

const eventId = Number(process.env.LOAD_TEST_EVENT_ID)
const owner = process.env.LOAD_TEST_OWNER
const other = process.env.LOAD_TEST_OTHER
if (
  !/^stillmark_loadtest_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '') ||
  process.env.PGUSER !== 'personal_photos_app' ||
  !process.env.PGHOST ||
  !Number.isSafeInteger(eventId) ||
  eventId < 1 ||
  !/^STILLMARK_LOADTEST_[A-Z0-9_]+$/.test(owner ?? '') ||
  !/^STILLMARK_LOADTEST_[A-Z0-9_]+$/.test(other ?? '') ||
  owner === other
)
  throw Error('Explicit isolated app-role connection and distinct fixture owners required')
const db = new pg.Client({
  connectionTimeoutMillis: 10000,
  statement_timeout: 10000,
  ssl: process.env.PGSSLROOTCERT
    ? { ca: await readFile(process.env.PGSSLROOTCERT, 'utf8'), rejectUnauthorized: true }
    : undefined,
})
await db.connect()
try {
  assert.equal(
    (await db.query('SELECT current_database() db,current_user name')).rows[0].db,
    process.env.PGDATABASE,
  )
  assert.equal((await db.query('SELECT current_user name')).rows[0].name, 'personal_photos_app')
  await db.query('BEGIN')
  const identity = async (username, hash = '', write = true, main = false) =>
    db.query(
      `SELECT set_config('photos.username',$1,true),set_config('photos.public_hash',$2,true),
     set_config('photos.can_write',$3,true),set_config('photos.main_admin',$4,true),
     set_config('photos.admin_read','false',true),set_config('photos.admin_write','false',true),set_config('photos.access_manager','false',true)`,
      [username, hash, String(write), String(main)],
    )
  const visible = async () =>
    (await db.query('SELECT event_id FROM events WHERE event_id=$1', [eventId])).rowCount
  await identity(owner)
  const event = (
    await db.query('SELECT event_name,owner_username,visibility FROM events WHERE event_id=$1', [
      eventId,
    ])
  ).rows[0]
  assert.ok(event?.event_name.startsWith('__loadtest_'))
  assert.equal(event.owner_username, owner)
  assert.equal(event.visibility, 'PRIVATE')
  const photos = (await db.query('SELECT photo_id FROM photos WHERE event_id=$1', [eventId]))
    .rowCount
  assert.ok(photos > 0)
  await identity(other)
  assert.equal(await visible(), 0)
  await identity(owner)
  await db.query('INSERT INTO album_shares(event_id,username,created_by) VALUES($1,$2,$3)', [
    eventId,
    other,
    owner,
  ])
  await identity(other)
  assert.equal(await visible(), 1)
  assert.equal(
    (
      await db.query('UPDATE photos SET caption=caption WHERE event_id=$1 RETURNING photo_id', [
        eventId,
      ])
    ).rowCount,
    0,
  )
  await identity(owner)
  await db.query('DELETE FROM album_shares WHERE event_id=$1 AND username=$2', [eventId, other])
  await identity(other)
  assert.equal(await visible(), 0)
  await identity(owner)
  const id = randomUUID()
  const hash = randomBytes(32).toString('hex')
  await db.query(
    "INSERT INTO album_public_links(id,event_id,token_hash,owner_username,created_by,expires_at) VALUES($1,$2,$3,$4,$4,now()+interval '1 hour')",
    [id, eventId, hash, owner],
  )
  await identity('', hash, false)
  assert.equal(await visible(), 1)
  assert.equal(
    (await db.query('SELECT photo_id FROM photos WHERE event_id=$1', [eventId])).rowCount,
    photos,
  )
  assert.equal(
    (
      await db.query('UPDATE photos SET caption=caption WHERE event_id=$1 RETURNING photo_id', [
        eventId,
      ])
    ).rowCount,
    0,
  )
  await identity(owner)
  await db.query('UPDATE album_public_links SET revoked_at=now() WHERE id=$1', [id])
  await identity('', hash, false)
  assert.equal(await visible(), 0)
  assert.equal(
    (await db.query('SELECT photo_id FROM photos WHERE event_id=$1', [eventId])).rowCount,
    0,
  )
  await identity('', '', true, true)
  assert.equal(await visible(), 0)
  await identity(other, '', true, true)
  assert.equal(await visible(), 1)
  await identity(owner, '', false)
  assert.equal(
    (
      await db.query('UPDATE photos SET caption=caption WHERE event_id=$1 RETURNING photo_id', [
        eventId,
      ])
    ).rowCount,
    0,
  )
  await db.query('ROLLBACK')
  assert.equal(await visible(), 0)
  console.log(
    'PASS: actual app role isolates owners, permits and revokes shares/public links, denies unauthorized writes, scopes admin flags, and clears identity; all mutations rolled back',
  )
} finally {
  await db.query('ROLLBACK').catch(() => {})
  await db.end()
}
