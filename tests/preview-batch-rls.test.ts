import { expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { previewBatchSql } from '../lib/media/preview-batch-query'

it('the set lookup preserves RLS filtering across albums, revoked shares, and incomplete uploads', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE ROLE preview_reader;
      CREATE TABLE events(id int PRIMARY KEY, owner_name text);
      CREATE TABLE shares(event_id int, username text);
      CREATE TABLE photos(photo_id int, event_id int, thumbnail_stage_path text, ingest_status text);
      INSERT INTO events VALUES(1,'alice'),(2,'bob');
      INSERT INTO shares VALUES(2,'alice');
      INSERT INTO photos VALUES(1,1,'thumbnails/a.jpg','READY'),(2,2,'thumbnails/b.jpg','READY'),(3,1,'thumbnails/pending.jpg','PENDING');
      ALTER TABLE photos ENABLE ROW LEVEL SECURITY;
      CREATE POLICY visible ON photos TO preview_reader USING (EXISTS (SELECT 1 FROM events e WHERE e.id=photos.event_id AND (e.owner_name=current_setting('photos.username') OR EXISTS(SELECT 1 FROM shares s WHERE s.event_id=e.id AND s.username=current_setting('photos.username')))));
      GRANT SELECT ON photos,events,shares TO preview_reader;
      SET ROLE preview_reader; SET photos.username='alice';`)
    const params = [
      ['thumbnails/a.jpg', 'thumbnails/b.jpg', 'thumbnails/pending.jpg', 'thumbnails/missing.jpg'],
    ]
    expect((await db.query(previewBatchSql, params)).rows).toHaveLength(2)
    await db.exec('RESET ROLE; DELETE FROM shares; SET ROLE preview_reader')
    expect((await db.query(previewBatchSql, params)).rows).toEqual([
      { thumbnail_stage_path: 'thumbnails/a.jpg' },
    ])
    await db.exec("SET photos.username='bob'")
    expect((await db.query(previewBatchSql, params)).rows).toEqual([
      { thumbnail_stage_path: 'thumbnails/b.jpg' },
    ])
  } finally {
    await db.close()
  }
})
