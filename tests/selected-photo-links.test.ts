import { createTestDatabase } from './fixtures/test-database'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'

let db: PGlite
beforeAll(async () => {
  db = await createTestDatabase({
    roles: [
      'snowflake_admin',
      'personal_photos_app NOINHERIT',
      'personal_photos_reader',
      'personal_photos_video_worker',
      'personal_photos_maintenance',
    ],
    steps: [
      {
        sql: 'SET search_path=public; GRANT USAGE ON SCHEMA public TO personal_photos_app; GRANT SELECT ON photos,events,album_public_links,video_playback TO personal_photos_app;',
      },
      'setup/72-app-rls.sql',
      {
        transaction: [
          '202610251400_album_permission_queries',
          '202610251430_permission_list_indexes',
        ],
      },
      {
        sql: `CREATE TABLE faces(face_id int,photo_id int,owner_username text,ignored boolean,box_x real,box_y real,box_w real,box_h real);
    CREATE TABLE face_assignments(face_id int,owner_username text,person_id int,status text);
    CREATE TABLE face_people(person_id int,owner_username text,name text,hidden boolean);`,
      },
      '202610202000_public_album_details',
      '202610241700_selected_photo_links',
      '202610270130_indexed_app_photo_policy',
    ],
  })
}, 30000)
afterAll(async () => db?.close())
beforeEach(async () => {
  await db.exec(`TRUNCATE events,photos,faces,face_people,face_assignments RESTART IDENTITY CASCADE;
    INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES
      (1,1,'Alice','a','ALICE','PRIVATE'),(2,2,'Bob','b','BOB','PRIVATE');
    INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path) VALUES
      (1,1,'one.jpg','photo','READY','originals/one.jpg'),(2,1,'two.mp4','video','READY','originals/two.mp4'),(3,2,'other.jpg','photo','READY','originals/other.jpg');
    INSERT INTO album_public_links(id,event_id,token_hash,owner_username,created_by,expires_at,allow_downloads,include_people,photo_ids) VALUES
      (gen_random_uuid(),1,'selected','ALICE','ALICE',now()+interval '1 day',true,true,ARRAY[1]),
      (gen_random_uuid(),1,'whole','ALICE','ALICE',now()+interval '1 day',true,true,NULL);
    INSERT INTO faces SELECT i,i,'ALICE',false,NULL,NULL,NULL,NULL FROM generate_series(1,2) i;
    INSERT INTO face_people VALUES(1,'ALICE','Person',false);
    INSERT INTO face_assignments SELECT i,'ALICE',1,'confirmed' FROM generate_series(1,2) i;`)
})
async function scope<T>(hash: string, fn: () => Promise<T>, user = '') {
  await db.exec('BEGIN; SET LOCAL ROLE personal_photos_app')
  try {
    await db.query(
      "SELECT set_config('photos.public_hash',$1,true), set_config('photos.username',$2,true)",
      [hash, user],
    )
    return await fn()
  } finally {
    await db.exec('ROLLBACK')
  }
}
const ids = async (hash: string) =>
  scope(
    hash,
    async () =>
      (await db.query('SELECT photo_id FROM photos WHERE event_id=1 ORDER BY photo_id')).rows,
  )
it('limits gallery and full ZIP queries to the selection, including older app queries', async () => {
  expect(await ids('selected')).toEqual([{ photo_id: 1 }])
  expect(await ids('whole')).toEqual([{ photo_id: 1 }, { photo_id: 2 }])
  expect(
    await scope(
      'selected',
      async () =>
        (
          await db.query(
            'SELECT original_stage_path FROM photos WHERE event_id=1 ORDER BY photo_id',
          )
        ).rows,
    ),
  ).toEqual([{ original_stage_path: 'originals/one.jpg' }])
})
it('denies guessed unselected IDs for media, details, video playback and names', async () => {
  await scope('selected', async () => {
    expect((await db.query('SELECT * FROM photos WHERE photo_id=2 AND event_id=1')).rows).toEqual(
      [],
    )
    expect((await db.query('SELECT * FROM video_playback WHERE photo_id=2')).rows).toEqual([])
    expect((await db.query('SELECT photo_security.read_photo(2) AS allowed')).rows).toEqual([
      { allowed: false },
    ])
    expect((await db.query('SELECT * FROM photo_security.public_photo_people(2)')).rows).toEqual([])
    expect((await db.query('SELECT name FROM photo_security.public_photo_people(1)')).rows).toEqual(
      [{ name: 'Person' }],
    )
  })
})
it('never adds later uploads to a selection but keeps whole-album links dynamic', async () => {
  await db.exec("INSERT INTO photos(photo_id,event_id,source_filename) VALUES(4,1,'later.jpg')")
  expect(await ids('selected')).toEqual([{ photo_id: 1 }])
  expect(await ids('whole')).toEqual([{ photo_id: 1 }, { photo_id: 2 }, { photo_id: 4 }])
})
it('an empty remaining selection does not turn into album access', async () => {
  await db.exec('UPDATE photos SET event_id=2 WHERE photo_id=1')
  expect(await ids('selected')).toEqual([])
  expect(
    await scope(
      'selected',
      async () => (await db.query('SELECT * FROM photo_security.public_photo_people(1)')).rows,
    ),
  ).toEqual([])
})
it('revocation, expiration, owner changes and invalid tokens fail closed', async () => {
  expect(await ids('missing')).toEqual([])
  await db.exec("UPDATE album_public_links SET revoked_at=now() WHERE token_hash='selected'")
  expect(await ids('selected')).toEqual([])
  await db.exec(
    "UPDATE album_public_links SET revoked_at=NULL,expires_at=now()-interval '1 day' WHERE token_hash='selected'",
  )
  expect(await ids('selected')).toEqual([])
  await db.exec(
    "UPDATE album_public_links SET expires_at=now()+interval '1 day' WHERE token_hash='selected'; UPDATE events SET owner_username='BOB' WHERE event_id=1",
  )
  expect(await ids('selected')).toEqual([])
})
it('preserves signed-in owner access with no public capability', async () => {
  expect(
    await scope(
      '',
      async () => (await db.query('SELECT photo_id FROM photos ORDER BY photo_id')).rows,
      'ALICE',
    ),
  ).toEqual([{ photo_id: 1 }, { photo_id: 2 }])
})
