import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it.each([false, true])(
  'RLS preserves tenant boundaries with indexed policy=%s',
  async (indexed) => {
    const db = new PGlite()
    try {
      await db.exec(`CREATE ROLE personal_photos_app;CREATE ROLE personal_photos_video_worker;
 CREATE TABLE events(event_id int PRIMARY KEY,owner_username text,visibility text);
 CREATE TABLE photos(photo_id int PRIMARY KEY,event_id int REFERENCES events);
 CREATE TABLE album_shares(event_id int,username text);
 INSERT INTO events VALUES(1,'ALICE','PRIVATE'),(2,'BOB','PRIVATE'),(3,'BOB','GALLERY'),(4,'BOB','PRIVATE');
 INSERT INTO photos VALUES(1,1),(2,2),(3,3),(4,4);INSERT INTO album_shares VALUES(4,'ALICE');`)
      await db.exec(readFileSync('setup/71-catalog-read-rls.sql', 'utf8'))
      if (indexed)
        await db.exec(
          readFileSync('migrations/postgres/202610260230_indexed_photo_read_policy.sql', 'utf8'),
        )
      await db.exec('SET ROLE personal_photos_reader')
      expect((await db.query('SELECT * FROM photos')).rows).toEqual([])
      await db.exec(
        "BEGIN READ ONLY;SELECT set_config('photos.username','ALICE',true),set_config('photos.main_admin','false',true)",
      )
      expect((await db.query('SELECT photo_id FROM photos ORDER BY photo_id')).rows).toEqual([
        { photo_id: 1 },
        { photo_id: 3 },
        { photo_id: 4 },
      ])
      await expect(db.query('DELETE FROM photos')).rejects.toThrow()
      await db.exec('ROLLBACK')
      expect((await db.query('SELECT * FROM photos')).rows).toEqual([])
      await db.exec(
        "BEGIN READ ONLY;SELECT set_config('photos.username','BOB',true),set_config('photos.main_admin','false',true)",
      )
      expect((await db.query('SELECT photo_id FROM photos ORDER BY photo_id')).rows).toEqual([
        { photo_id: 2 },
        { photo_id: 3 },
        { photo_id: 4 },
      ])
      await db.exec('COMMIT')
      expect((await db.query('SELECT * FROM events')).rows).toEqual([])
      await db.exec(
        "BEGIN READ ONLY;SELECT set_config('photos.username','OWNER',true),set_config('photos.main_admin','true',true)",
      )
      expect((await db.query('SELECT * FROM photos')).rows).toHaveLength(4)
      await db.exec('COMMIT;RESET ROLE')
      await db.exec(
        "DELETE FROM album_shares WHERE event_id=4; UPDATE events SET visibility='PRIVATE' WHERE event_id=3",
      )
      await db.exec(
        "SET ROLE personal_photos_reader; BEGIN READ ONLY; SELECT set_config('photos.username','ALICE',true),set_config('photos.main_admin','false',true)",
      )
      expect((await db.query('SELECT photo_id FROM photos ORDER BY photo_id')).rows).toEqual([
        { photo_id: 1 },
      ])
      await db.exec('COMMIT;RESET ROLE')
    } finally {
      await db.close()
    }
  },
  30000,
)
