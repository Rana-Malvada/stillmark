import { PGlite } from '@electric-sql/pglite'
import { expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ db: null as any }))
vi.mock('@/lib/postgres', () => ({
  pgQueryOne: async (sql: string, args: unknown[]) => (await m.db.query(sql, args)).rows[0],
  pgReadIdentity: async (_caller: unknown, work: () => unknown) => work(),
  pgQuery: vi.fn(),
  pgTransaction: vi.fn(),
}))
vi.mock('@/lib/albums/album-access', () => ({ canEditAlbum: vi.fn() }))
import { getPhotoViewerPage } from '@/lib/photos'

const caller = { username: 'alice', role: 'viewer' as const, mainAdmin: false }
it('bounded neighbors preserve capture order, ties, deleted rows, and album boundaries', async () => {
  const db = (m.db = new PGlite())
  try {
    await db.exec(`CREATE TABLE events(event_id int,owner_username text,visibility text,cover_photo_id int);
      CREATE TABLE album_shares(event_id int,username text);
      INSERT INTO events VALUES(1,'alice','PRIVATE',null),(2,'alice','PRIVATE',null);
      CREATE TABLE photos(photo_id int,event_id int,date_taken timestamptz,created_at timestamptz NOT NULL,ingest_status text,media_type text,favorite boolean DEFAULT false,source_filename text,camera_make text,camera_model text,country text,region text,city text,location_name text,display_stage_path text,width int,height int);
      INSERT INTO photos(photo_id,event_id,date_taken,created_at,ingest_status,media_type,display_stage_path,width,height) SELECT n,1,CASE WHEN n%3=0 THEN null ELSE '2026-01-01'::timestamptz END,'2026-01-01','READY','photo','path',100,100 FROM generate_series(1,50)n;
      UPDATE photos SET ingest_status='FAILED' WHERE photo_id=20;
      INSERT INTO photos(photo_id,event_id,date_taken,created_at,ingest_status,media_type,display_stage_path,width,height) VALUES(99,2,null,'2026-01-01','READY','photo','other',100,100);`)
    const baseline = await db.query<{
      photo_id: number
      prev: number | null
      next: number | null
      next2: number | null
    }>(
      `SELECT photo_id,LAG(photo_id) OVER(ORDER BY COALESCE(date_taken,created_at),photo_id) AS prev,LEAD(photo_id) OVER(ORDER BY COALESCE(date_taken,created_at),photo_id) AS next,LEAD(photo_id,2) OVER(ORDER BY COALESCE(date_taken,created_at),photo_id) AS next2 FROM photos WHERE event_id=1 AND ingest_status='READY'`,
    )
    for (const row of baseline.rows) {
      const actual = await getPhotoViewerPage(row.photo_id, caller)
      expect(actual?.adjacent).toEqual({ prev: row.prev, next: row.next, next2: row.next2 })
    }
    // The only photo of another readable album has no neighbors from this one.
    expect((await getPhotoViewerPage(99, caller))?.adjacent).toEqual({
      prev: null,
      next: null,
      next2: null,
    })
  } finally {
    await db.close()
  }
})
