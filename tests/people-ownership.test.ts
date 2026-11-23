import { createTestDatabase } from './fixtures/test-database'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Regression tests for review findings: face data must follow the photo's current
// owner; Undo must reverse the change it describes; hidden people leave photos.
const state = vi.hoisted(() => ({
  db: null as import('@electric-sql/pglite').PGlite | null,
  user: 'ALICE',
  inTx: false,
}))
async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (state.inTx) return fn()
  const db = state.db!
  await db.exec('BEGIN;SET LOCAL ROLE personal_photos_app')
  for (const [k, v] of Object.entries({ username: state.user, can_write: 'true' }))
    await db.query('SELECT set_config($1,$2,true)', ['photos.' + k, v])
  state.inTx = true
  try {
    const result = await fn()
    await db.exec('COMMIT')
    return result
  } catch (error) {
    await db.exec('ROLLBACK')
    throw error
  } finally {
    state.inTx = false
  }
}
vi.mock('@/lib/postgres', () => {
  const pgQuery = (sql: string, params: unknown[] = []) =>
    tx(async () => (await state.db!.query(sql, params)).rows)
  return {
    pgQuery,
    pgQueryOne: async (sql: string, params?: unknown[]) => (await pgQuery(sql, params))[0] ?? null,
    pgTransaction: tx,
  }
})
vi.mock('@/lib/snowflake', () => ({
  querySnowflakeStorage: vi.fn(),
  querySnowflake: vi.fn(async () => [{ URL: 'https://stage.example/crop' }]),
  getSnowflakeBaseUrl: () => 'https://example.snowflakecomputing.com',
  getRestApiAuthHeader: () => 'Bearer test',
}))
import * as people from '@/lib/people'
/** The People overview exactly as the API requests its first page. */
const overview = () => people.listPeople({ kind: 'all' })
import { visibleCrop } from '@/lib/people/face-crops'
import { search } from '@/lib/search'

const DANA = '22222222-2222-4222-8222-222222222222'
const CROP = 'faces/0b6c1a52-7f0e-4a7e-9a55-3f5d2f1c9e10.webp'
const admin = async (sql: string) => (await state.db!.query(sql)).rows as Record<string, any>[]
const asUser = async <T>(user: string, fn: () => Promise<T>) => {
  state.user = user
  try {
    return await fn()
  } finally {
    state.user = 'ALICE'
  }
}

beforeAll(async () => {
  state.db = await createTestDatabase({
    extensions: true,
    beforeSchema:
      'CREATE TABLE search_enrichment(photo_id int PRIMARY KEY,source_path text,status text,ocr_text text)',
    roles: [
      'snowflake_admin',
      'personal_photos_app NOINHERIT',
      'personal_photos_reader',
      'personal_photos_video_worker',
      'personal_photos_maintenance',
    ],
    steps: [
      {
        sql: `SET search_path=public;GRANT USAGE ON SCHEMA public TO personal_photos_app;
 GRANT SELECT,INSERT,UPDATE,DELETE ON events,photos,album_shares,album_public_links,stage_cleanup TO personal_photos_app;`,
      },
      'setup/72-app-rls.sql',
      { sql: 'GRANT SELECT ON search_enrichment TO personal_photos_app' },
      '202610072000_people_faces',
      '202610072010_people_worker_queue',
      '202610072100_people_publish_fix',
      '202610072200_people_merge_unnamed',
      '202610080900_people_delete_history',
      '202610081000_people_owner_scope',
      '202611142300_people_counts',
    ],
  })
}, 60000)
afterAll(async () => state.db?.close())
beforeEach(async () => {
  state.user = 'ALICE'
  await state.db!.exec(`RESET ROLE;
 TRUNCATE face_corrections, face_rejections, face_assignments, face_people, faces, face_scan_queue, face_settings,
   stage_cleanup, album_shares, photos, events RESTART IDENTITY CASCADE;
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES
  (1,1,'Alice','a','ALICE','PRIVATE'),(2,2,'Bob','b','BOB','PRIVATE');
 INSERT INTO face_settings(owner_username,enabled,share_names) VALUES('ALICE',true,true),('BOB',true,false);
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path) VALUES
  (1,1,'1.jpg','photo','READY','o/1'),(2,1,'2.jpg','photo','READY','o/2');
 UPDATE face_scan_queue SET status='done';
 INSERT INTO face_people(person_id,owner_username,name) VALUES('${DANA}','ALICE','Dana');
 INSERT INTO faces(photo_id,owner_username,source,source_path,model_version,face_index,box_x,box_y,box_w,box_h,detection_score,quality,quality_ok,embedding,crop_path)
  VALUES(1,'ALICE','detected','o/1','m',0,0.1,0.1,0.2,0.2,0.9,0.9,true,'[1,0]','${CROP}'),
        (2,'ALICE','detected','o/2','m',0,0.1,0.1,0.2,0.2,0.9,0.9,true,'[1,0]',NULL);
 INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES(1,'${DANA}','ALICE','confirmed'),(2,'${DANA}','ALICE','auto');`)
})

describe('face data follows the photo owner (finding 1)', () => {
  it('retires the former owner’s faces when a photo moves to another owner’s album', async () => {
    expect(await visibleCrop(1)).toBe(CROP)
    await admin('UPDATE photos SET event_id=2 WHERE photo_id=1')
    await expect(visibleCrop(1)).rejects.toMatchObject({ status: 404 })
    expect(await admin('SELECT face_id FROM faces WHERE photo_id=1')).toEqual([])
    expect(await admin(`SELECT path FROM stage_cleanup`)).toEqual([{ path: CROP }])
    // Queued for the new owner, who has People on.
    expect(
      await admin('SELECT owner_username, status FROM face_scan_queue WHERE photo_id=1'),
    ).toEqual([{ owner_username: 'BOB', status: 'queued' }])
    const found = await search(
      'photo',
      { query: 'Dana', limit: 50, eventId: null, semantic: false },
      [1],
    )
    expect(found.results.map((r) => r.photoId)).toEqual([2])
    expect((await overview()).named[0].photoCount).toBe(1)
  })
  it('retires faces when an album changes owner', async () => {
    await admin(`UPDATE events SET owner_username='BOB' WHERE event_id=1`)
    expect(await admin('SELECT count(*)::int AS n FROM faces')).toEqual([{ n: 0 }])
    expect(
      (await admin('SELECT array_agg(owner_username) AS o FROM face_scan_queue'))[0].o,
    ).toEqual(['BOB', 'BOB'])
    expect((await overview()).named).toEqual([])
  })
  it('hides faces whose owner no longer owns the photo even before retirement', async () => {
    // Simulates data that predates the trigger: the policy alone must deny it.
    await state.db!.exec(`ALTER TABLE photos DISABLE TRIGGER retire_moved_faces;
      UPDATE photos SET event_id=2 WHERE photo_id=1; ALTER TABLE photos ENABLE TRIGGER retire_moved_faces;`)
    await expect(visibleCrop(1)).rejects.toMatchObject({ status: 404 })
    expect(await asUser('BOB', () => visibleCrop(1).catch((e) => e.status))).toBe(404)
    await expect(people.rejectFaces(DANA, [1])).rejects.toMatchObject({ status: 404 })
    expect((await people.getPerson(DANA)).faces.map((f) => f.faceId)).toEqual([2])
  })
  it('leaves faces alone when a photo moves between the same owner’s albums', async () => {
    await admin(
      `INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES(3,3,'Alice 2','c','ALICE','PRIVATE')`,
    )
    await admin('UPDATE photos SET event_id=3 WHERE photo_id=1')
    expect(await visibleCrop(1)).toBe(CROP)
    expect(await admin('SELECT path FROM stage_cleanup')).toEqual([])
  })
})

describe('Undo reverses the change it describes (finding 2)', () => {
  it('returns each correction’s id and refuses to undo once a newer change exists', async () => {
    const first = await people.renamePerson(DANA, 'Dana L')
    const second = await people.setHidden(DANA, true)
    expect(second.correctionId).toBeGreaterThan(first.correctionId)
    await expect(people.undo(first.correctionId)).rejects.toMatchObject({ status: 409 })
    expect((await admin(`SELECT name, hidden FROM face_people`))[0]).toEqual({
      name: 'Dana L',
      hidden: true,
    })
    await people.undo(second.correctionId)
    await people.undo(first.correctionId)
    expect((await admin(`SELECT name, hidden FROM face_people`))[0]).toEqual({
      name: 'Dana',
      hidden: false,
    })
  })
})

describe('hidden people leave photos (finding 3)', () => {
  it('omits a hidden person’s faces from the owner’s photo panel', async () => {
    expect((await people.photoPeople(1)).faces.map((f) => f.faceId)).toEqual([1])
    await people.setHidden(DANA, true)
    expect((await people.photoPeople(1)).faces).toEqual([])
  })
})
