import { createTestDatabase } from './fixtures/test-database'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({ db: null as PGlite | null, tx: null as any, user: 'ALICE' }))
vi.mock('@/lib/albums/album-access', () => ({
  albumCaller: async () => ({ username: s.user, mainAdmin: false }),
}))
vi.mock('@/lib/postgres', () => ({
  pgQuery: async (sql: string, args: unknown[]) => (await s.tx.query(sql, args)).rows,
  pgReadIdentity: async (_caller: unknown, fn: () => Promise<unknown>) =>
    s.db!.transaction(async (tx) => {
      s.tx = tx
      try {
        await tx.exec('SET LOCAL ROLE personal_photos_reader')
        await tx.query("SELECT set_config('photos.username',$1,true)", [s.user])
        return await fn()
      } finally {
        s.tx = null
      }
    }),
}))
import { travelStops, viewportClusters } from '@/lib/travel/travels'

beforeAll(async () => {
  s.db = await createTestDatabase({
    roles: [
      'snowflake_admin',
      'personal_photos_app NOINHERIT',
      'personal_photos_reader',
      'personal_photos_video_worker',
      'personal_photos_maintenance',
      'personal_photos_search_worker',
    ],
    steps: [
      {
        sql: 'SET search_path=public;GRANT USAGE ON SCHEMA public TO personal_photos_app; GRANT SELECT ON events,photos,album_shares TO personal_photos_app',
      },
      'setup/71-catalog-read-rls.sql',
      'setup/72-app-rls.sql',
      '202610292200_travel_summaries',
      '202610300300_travel_summary_reader',
    ],
  })
})
beforeEach(async () => {
  const db = s.db!
  await db.exec('RESET ROLE;TRUNCATE events CASCADE')
  await db.exec(`INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility,event_year) VALUES
   (1,1,'First','a','ALICE','PRIVATE',2024),(2,2,'Second','b','ALICE','PRIVATE',2024),(3,3,'Third','c','BOB','PRIVATE',2025),(4,4,'Undated','d','ALICE','PRIVATE',NULL);
   INSERT INTO album_shares(event_id,username,created_by) VALUES(1,'CAROL','ALICE');
   INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,date_taken,latitude,longitude,country,city,thumbnail_stage_path) VALUES
   (1,1,'1.jpg','photo','READY','2024-02-01',10.04,20.04,' A ','X','t/1'),
   (2,1,'2.jpg','photo','READY',NULL,10.04,20.04,'A','X',NULL),
   (3,1,'3.jpg','photo','READY','2025-01-01',10.049,20.049,'A','X','t/3'),
   (4,2,'4.jpg','photo','READY',NULL,10.04,20.04,'A','X','t/4'),
   (5,2,'5.jpg','photo','READY','2024-01-01',100,20,'A','X',NULL),
   (6,3,'6.jpg','photo','READY','2024-01-01',10.04,20.04,'A','X','t/6'),
   (7,2,'7.jpg','photo','READY',NULL,NULL,NULL,'','',NULL),
   (8,2,'8.jpg','photo','READY',NULL,-10.04,-179.9,'B','Y','t/8'),
   (9,2,'9.jpg','photo','READY',NULL,-10.04,179.9,'B','Y','t/9'),
   (10,2,'10.jpg','photo','READY','2024-01-01',10.049,20.049,'A','Y','t/10'),
   (11,4,'11.jpg','photo','READY',NULL,25,35,'C','Z','t/11'),
   (12,4,'12.jpg','photo','READY','2024-12-31 23:30-02',25,35,'C','Z','t/12');
   INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,date_taken,latitude,longitude,country,city)
   SELECT 100+i,1,i||'.jpg','photo','READY','2024-02-01',10.04,20.04,'A','X' FROM generate_series(1,20)i;`)
})
afterAll(async () => {
  await s.db?.close()
})
afterEach(() => {
  vi.unstubAllEnvs()
  s.user = 'ALICE'
})
async function rebuild() {
  while (
    (await s.db!.query<{ id: number | null }>('SELECT photo_security.refresh_travel_summary() id'))
      .rows[0].id !== null
  ) {}
}
const sorted = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).sort()
async function compare() {
  for (const scope of ['mine', 'accessible'] as const) {
    vi.stubEnv('TRAVEL_SUMMARIES_ENABLED', 'false')
    const expected = await travelStops(scope)
    vi.stubEnv('TRAVEL_SUMMARIES_ENABLED', 'true')
    expect(sorted(await travelStops(scope))).toEqual(sorted(expected))
    for (const year of ['all', '2024', '2025', 'undated']) {
      for (const [west, east] of [
        [-180, 180],
        [179, 180],
        [-180, -179],
        [20.045, 20.05],
      ]) {
        const params = new URLSearchParams({
          south: '-90',
          north: '90',
          west: String(west),
          east: String(east),
          zoom: '3',
          year,
        })
        vi.stubEnv('TRAVEL_SUMMARIES_ENABLED', 'false')
        const raw = await viewportClusters(scope, params)
        vi.stubEnv('TRAVEL_SUMMARIES_ENABLED', 'true')
        const actual = await viewportClusters(scope, params)
        expect(actual).toHaveLength(raw.length)
        for (let i = 0; i < raw.length; i++) {
          expect(actual[i]).toMatchObject({
            id: raw[i].id,
            count: raw[i].count,
            points: raw[i].points,
            areaId: raw[i].areaId,
          })
          expect(actual[i].lat).toBeCloseTo(raw[i].lat, 10)
          expect(actual[i].lng).toBeCloseTo(raw[i].lng, 10)
        }
      }
    }
  }
}
it('matches raw maps with cold, mixed and warm summaries including exact viewport edges and point counts', async () => {
  await compare()
  await s.db!.query('SELECT photo_security.refresh_travel_summary()')
  await compare()
  await rebuild()
  await compare()
  const count = (
    await s.db!.query<{ n: number }>('SELECT count(*)::int n FROM travel_point_summary')
  ).rows[0].n
  expect(count).toBeLessThan(30)
})
it('falls back immediately for GPS/date/thumbnail changes and ignores caption-only changes', async () => {
  await rebuild()
  const state = () =>
    s.db!.query<{ ready: boolean }>(
      'SELECT built_revision=revision ready FROM travel_summary_state WHERE event_id=1',
    )
  await s.db!.exec("UPDATE photos SET caption='unrelated description' WHERE photo_id=1")
  expect((await state()).rows[0].ready).toBe(true)
  for (const change of ['latitude=15', "date_taken='2025-02-01'", 'thumbnail_stage_path=NULL']) {
    await s.db!.exec(`UPDATE photos SET ${change} WHERE photo_id=1`)
    expect((await state()).rows[0].ready).toBe(false)
    await compare()
    await rebuild()
    await compare()
  }
})
it('keeps owner, sharing, album names and fallback years live without a summary rebuild', async () => {
  await rebuild()
  s.user = 'CAROL'
  await compare()
  await s.db!.exec("DELETE FROM album_shares WHERE username='CAROL'")
  await compare()
  vi.stubEnv('TRAVEL_SUMMARIES_ENABLED', 'true')
  expect(await travelStops('accessible')).toEqual([])
  await s.db!.exec(
    "UPDATE events SET owner_username='BOB',event_name='Moved album',event_year=2025 WHERE event_id=2",
  )
  s.user = 'ALICE'
  await compare()
  s.user = 'BOB'
  await compare()
})
it('invalidates both albums on photo moves and falls back correctly on deletion', async () => {
  await rebuild()
  await s.db!.exec('UPDATE photos SET event_id=2 WHERE photo_id=3')
  expect(
    (
      await s.db!.query(
        'SELECT event_id FROM travel_summary_state WHERE built_revision IS DISTINCT FROM revision ORDER BY event_id',
      )
    ).rows,
  ).toEqual([{ event_id: 1 }, { event_id: 2 }])
  await compare()
  await rebuild()
  await s.db!.exec('DELETE FROM photos WHERE photo_id=1')
  await compare()
  await rebuild()
  await compare()
})
it('denies app summary writes/builds and applies RLS even to direct summary reads', async () => {
  await rebuild()
  await s.db!.exec("DELETE FROM album_shares WHERE username='CAROL'")
  await s.db!.exec(
    "SET ROLE personal_photos_app; SELECT set_config('photos.username','CAROL',false)",
  )
  try {
    for (const table of ['travel_summary_state', 'travel_area_summary', 'travel_point_summary'])
      expect((await s.db!.query(`SELECT * FROM ${table}`)).rows).toEqual([])
    await expect(s.db!.query('SELECT photo_security.refresh_travel_summary()')).rejects.toThrow(
      'permission denied',
    )
    await expect(s.db!.query('DELETE FROM travel_area_summary')).rejects.toThrow(
      'permission denied',
    )
  } finally {
    await s.db!.exec('RESET ROLE')
  }
})

it('removes derived rows when an album is deleted', async () => {
  await rebuild()
  await s.db!.exec('DELETE FROM photos WHERE event_id=1;DELETE FROM events WHERE event_id=1')
  for (const table of ['travel_summary_state', 'travel_area_summary', 'travel_point_summary'])
    expect((await s.db!.query(`SELECT * FROM ${table} WHERE event_id=1`)).rows).toEqual([])
  await compare()
})

it('reader denies absent identity, writes and builder execution', async () => {
  await rebuild()
  await s.db!.exec("SET ROLE personal_photos_reader; SELECT set_config('photos.username','',false)")
  try {
    for (const table of ['travel_summary_state', 'travel_area_summary', 'travel_point_summary']) {
      expect((await s.db!.query(`SELECT * FROM ${table}`)).rows).toEqual([])
      await expect(s.db!.query(`DELETE FROM ${table}`)).rejects.toThrow('permission denied')
    }
    await expect(s.db!.query('SELECT photo_security.refresh_travel_summary()')).rejects.toThrow(
      'permission denied',
    )
  } finally {
    await s.db!.exec('RESET ROLE')
  }
})
