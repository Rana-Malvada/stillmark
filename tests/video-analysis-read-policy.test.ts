import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('preserves owner, shared, gallery and trash access and observes revocation', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE ROLE personal_photos_app; CREATE ROLE personal_photos_video_worker;
      CREATE TABLE events(event_id int PRIMARY KEY,owner_username text,visibility text);
      CREATE TABLE photos(photo_id int PRIMARY KEY,event_id int REFERENCES events);
      CREATE TABLE album_shares(event_id int,username text);
      CREATE TABLE photo_trash(photo_id int PRIMARY KEY,owner_username text);
      CREATE TABLE video_analyses(id int PRIMARY KEY,photo_id int);
      INSERT INTO events VALUES(1,'ALICE','PRIVATE'),(2,'BOB','PRIVATE'),(3,'BOB','GALLERY'),(4,'BOB','PRIVATE');
      INSERT INTO photos VALUES(1,1),(2,2),(3,3),(4,4);
      INSERT INTO album_shares VALUES(4,'ALICE');
      INSERT INTO photo_trash VALUES(5,'ALICE'),(6,'BOB');
      INSERT INTO video_analyses VALUES(1,1),(2,2),(3,3),(4,4),(5,5),(6,6),(7,999);`)
    await db.exec(readFileSync('setup/71-catalog-read-rls.sql', 'utf8'))
    await db.exec(`DROP POLICY catalog_runtime ON events; DROP POLICY catalog_runtime ON photos; DROP POLICY catalog_runtime ON album_shares; GRANT personal_photos_reader TO personal_photos_app;
      GRANT SELECT ON video_analyses,photo_trash TO personal_photos_app;
      ALTER TABLE photo_trash ENABLE ROW LEVEL SECURITY;
      CREATE POLICY trash_read ON photo_trash FOR SELECT TO personal_photos_app USING(owner_username=current_setting('photos.username',true) OR current_setting('photos.main_admin',true)='true');
      ALTER TABLE video_analyses ENABLE ROW LEVEL SECURITY;
      CREATE POLICY app_read ON video_analyses FOR SELECT TO personal_photos_app USING(photo_id IN(SELECT p.photo_id FROM photos p) OR photo_id IN(SELECT t.photo_id FROM photo_trash t));`)
    async function visible(user: string, main = false) {
      await db.exec('BEGIN;SET LOCAL ROLE personal_photos_app')
      try {
        await db.query(
          "SELECT set_config('photos.username',$1,true),set_config('photos.main_admin',$2,true)",
          [user, String(main)],
        )
        return (
          await db.query<{ id: number }>('SELECT id FROM video_analyses ORDER BY id')
        ).rows.map((r) => r.id)
      } finally {
        await db.exec('ROLLBACK')
      }
    }
    const before = await visible('ALICE')
    await db.exec(
      readFileSync('migrations/postgres/202610280120_video_analysis_read_policy.sql', 'utf8'),
    )
    expect(await visible('ALICE')).toEqual(before)
    expect(await visible('ALICE')).toEqual([1, 3, 4, 5])
    expect(await visible('BOB')).toEqual([2, 3, 4, 6])
    expect(await visible('OWNER', true)).toEqual([1, 2, 3, 4, 5, 6])
    expect(await visible('')).toEqual([])
    await db.exec(
      "DELETE FROM album_shares; UPDATE events SET visibility='PRIVATE' WHERE event_id=3",
    )
    expect(await visible('ALICE')).toEqual([1, 5])
  } finally {
    await db.close()
  }
}, 30000)
