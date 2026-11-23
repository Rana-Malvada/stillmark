import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'
import { acknowledgeEventsSql, acknowledgePhotosSql } from '@/lib/search/search-sync-ack'

it('acknowledges a batch atomically without dropping later edits, and tolerates deleted photos/retries', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE TABLE photos(photo_id int primary key,search_synced_at timestamptz);
    CREATE TABLE search_queue(kind text,id int,revision bigint,PRIMARY KEY(kind,id));
    INSERT INTO photos VALUES(1,NULL),(2,NULL),(4,NULL);
    INSERT INTO search_queue VALUES('photo',1,100),('photo',2,201),('photo',3,300),('event',1,100);`)
    await db.query(acknowledgePhotosSql, [
      [1, 2, 3],
      ['100', '200', '300'],
      [1, 2],
    ])
    expect((await db.query("SELECT id FROM search_queue WHERE kind='photo'")).rows).toEqual([
      { id: 2 },
    ])
    expect(
      (await db.query('SELECT photo_id FROM photos WHERE search_synced_at IS NOT NULL')).rows,
    ).toEqual([{ photo_id: 1 }])
    await db.query(acknowledgePhotosSql, [
      [1, 2, 3],
      ['100', '200', '300'],
      [1, 2],
    ])
    await db.query(acknowledgeEventsSql, [[1], ['99']])
    expect((await db.query('SELECT count(*)::int n FROM search_queue')).rows).toEqual([{ n: 2 }])
    await db.query(acknowledgeEventsSql, [[1], ['100']])
    expect((await db.query('SELECT count(*)::int n FROM search_queue')).rows).toEqual([{ n: 1 }])
  } finally {
    await db.close()
  }
})

it('clears the acknowledged search copy when a retained photo is removed from search', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE TABLE photos(photo_id int primary key,search_synced_at timestamptz);
      CREATE TABLE search_queue(kind text,id int,revision bigint,PRIMARY KEY(kind,id));
      INSERT INTO photos VALUES(1,now());
      INSERT INTO search_queue VALUES('photo',1,10);`)
    await db.query(acknowledgePhotosSql, [[1], ['10'], []])
    expect((await db.query('SELECT search_synced_at FROM photos')).rows).toEqual([
      { search_synced_at: null },
    ])
    expect((await db.query('SELECT count(*)::int n FROM search_queue')).rows).toEqual([{ n: 0 }])
  } finally {
    await db.close()
  }
})
