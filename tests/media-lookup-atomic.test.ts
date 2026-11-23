import { createTestDatabase } from './fixtures/test-database'
import { randomUUID } from 'node:crypto'
import { gatewayMediaBootstrapSql, gatewayMediaPath } from '../lib/identity/gateway-media-bootstrap'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'

let db: PGlite
beforeAll(async () => {
  db = await createTestDatabase({
    roles: [
      'snowflake_admin',
      'personal_photos_app NOINHERIT',
      'personal_photos_reader',
      'personal_photos_video_worker',
    ],
    steps: [
      {
        sql: `SET search_path=public; GRANT USAGE ON SCHEMA public TO personal_photos_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO personal_photos_app;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO personal_photos_app;
    INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES
      (1,1,'Alice','a','ALICE','PRIVATE'),(2,2,'Bob','b','BOB','PRIVATE'),(3,3,'Gallery','c','BOB','GALLERY');
    INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path,thumbnail_stage_path) VALUES
      (1,1,'a.jpg','photo','READY','a','ta'),(2,2,'b.jpg','photo','READY','b','tb'),(3,3,'c.jpg','photo','READY','c','tc');`,
      },
      'setup/72-app-rls.sql',
      { transaction: ['202610062200_media_lookup_indexes', '202610062230_video_path_catalog'] },
      '202610270130_indexed_app_photo_policy',
      '202610270330_media_lookup_roundtrip',
      '202610062030_gateway_security',
      '202610280100_app_permissions',
      '202610280110_app_permission_cardinality',
    ],
  })
  for (const name of ['ALICE', 'BOB', 'OWNER', 'NONE']) {
    const marker = randomUUID()
    await db.query(
      "INSERT INTO gallery_access_objects(kind,name,marker,display_name,created_by,state,auth0_user_id) VALUES('user',$1,$2,$1,'test','ready',$3)",
      [name, marker, 'auth0|' + name],
    )
    await db.query('INSERT INTO photo_security.app_principals(marker) VALUES($1)', [marker])
    if (name !== 'NONE')
      await db.query('INSERT INTO photo_security.app_memberships(marker,role_key) VALUES($1,$2)', [
        marker,
        name === 'OWNER' ? 'app_owner' : 'viewer',
      ])
  }
}, 30000)
afterAll(async () => db?.close())
afterEach(async () => {
  await db.exec('RESET ROLE')
})
async function lookup(path: string, username = 'ALICE', mainAdmin = false) {
  const r = await db.query<{ photo: { photo_id: number } | null }>(
    'SELECT photo_security.lookup_media($1,$2::jsonb) AS photo',
    [path, JSON.stringify({ username, mainAdmin, adminRead: false })],
  )
  return r.rows[0].photo
}
it('enforces RLS and restores identity before the connection is reused', async () => {
  await db.exec('SET ROLE personal_photos_app')
  try {
    expect((await lookup('ta'))?.photo_id).toBe(1)
    expect(await lookup('tb')).toBeNull()
    expect((await lookup('tc'))?.photo_id).toBe(3)
    expect((await lookup('tb', 'BOB'))?.photo_id).toBe(2)
    expect(await lookup('ta', 'BOB')).toBeNull()
    expect(
      (await db.query("SELECT nullif(current_setting('photos.username',true),'') AS who")).rows,
    ).toEqual([{ who: null }])
    expect((await db.query('SELECT photo_id FROM photos')).rows).toEqual([])
    await expect(lookup('ta', '')).rejects.toThrow('Media identity required')
    expect((await lookup('tb', 'ALICE', true))?.photo_id).toBe(2)
  } finally {
    await db.exec('RESET ROLE')
  }
})
it('observes sharing and revocation immediately', async () => {
  await db.exec(
    "INSERT INTO album_shares(event_id,username,created_by) VALUES(2,'ALICE','BOB'); SET ROLE personal_photos_app",
  )
  expect((await lookup('tb'))?.photo_id).toBe(2)
  await db.exec(
    'RESET ROLE; DELETE FROM album_shares WHERE event_id=2; SET ROLE personal_photos_app',
  )
  expect(await lookup('tb')).toBeNull()
  await db.exec('RESET ROLE')
})
it('does not expose the identity-setting function to unrelated roles', async () => {
  await db.exec(
    'CREATE ROLE media_unrelated; GRANT USAGE ON SCHEMA photo_security TO media_unrelated; SET ROLE media_unrelated',
  )
  try {
    await expect(lookup('ta')).rejects.toThrow(/permission denied/)
  } finally {
    await db.exec('RESET ROLE')
  }
})

async function combined(name: string, path: string, sid = randomUUID(), jti = randomUUID()) {
  return (
    await db.query<any>(gatewayMediaBootstrapSql, [
      'auth0|' + name,
      sid,
      jti,
      Math.floor(Date.now() / 1000) + 30,
      path,
    ])
  ).rows[0]
}
it('combines current authorization and exact media access without leaking identity', async () => {
  await db.exec('SET ROLE personal_photos_app')
  expect((await combined('ALICE', 'ta')).prefetched_media.photo_id).toBe(1)
  expect((await combined('ALICE', 'tb')).prefetched_media).toBeNull()
  expect((await combined('BOB', 'tb')).prefetched_media.photo_id).toBe(2)
  expect((await combined('OWNER', 'tb')).prefetched_media.photo_id).toBe(2)
  expect((await combined('NONE', 'tc')).prefetched_media).toBeNull()
  expect(await combined('UNLINKED', 'tc')).toBeUndefined()
  expect((await db.query('SELECT photo_id FROM photos')).rows).toEqual([])
})
it('rejects replay, revoked sessions, disabled principals and removed roles in the combined read', async () => {
  const sid = randomUUID()
  const jti = randomUUID()
  await db.exec('SET ROLE personal_photos_app')
  expect((await combined('ALICE', 'ta', sid, jti)).prefetched_media.photo_id).toBe(1)
  expect(await combined('ALICE', 'ta', sid, jti)).toBeUndefined()
  await db.exec('RESET ROLE')
  await db.query(
    "INSERT INTO gallery_revoked_sessions(sid,expires_at) VALUES($1,now()+interval '1 hour')",
    [sid],
  )
  await db.exec('SET ROLE personal_photos_app')
  expect((await combined('ALICE', 'ta', sid)).prefetched_media).toBeNull()
  await db.exec(
    "RESET ROLE; UPDATE photo_security.app_principals SET enabled=false WHERE marker=(SELECT marker FROM gallery_access_objects WHERE name='ALICE'); SET ROLE personal_photos_app",
  )
  expect((await combined('ALICE', 'ta')).prefetched_media).toBeNull()
  await db.exec(
    "RESET ROLE; UPDATE photo_security.app_principals SET enabled=true WHERE marker=(SELECT marker FROM gallery_access_objects WHERE name='ALICE'); DELETE FROM photo_security.app_memberships WHERE marker=(SELECT marker FROM gallery_access_objects WHERE name='ALICE'); SET ROLE personal_photos_app",
  )
  expect((await combined('ALICE', 'ta')).prefetched_media).toBeNull()
})
it('only prefetches the bound image GET path', () => {
  expect(gatewayMediaPath({ method: 'GET', target: '/api/images?path=thumbnails%2Fa.jpg' })).toBe(
    'thumbnails/a.jpg',
  )
  for (const binding of [
    undefined,
    { method: 'POST', target: '/api/images?path=thumbnails/a.jpg' },
    { method: 'GET', target: '/api/events?path=thumbnails/a.jpg' },
    { method: 'GET', target: '/api/images?path=bad' },
  ])
    expect(gatewayMediaPath(binding)).toBeNull()
})
