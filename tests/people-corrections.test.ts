import { createTestDatabase } from './fixtures/test-database'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  db: null as import('@electric-sql/pglite').PGlite | null,
  user: 'ALICE',
  mainAdmin: false,
  inTx: false,
}))
// Mirrors lib/postgres: one transaction per call or per pgTransaction, as the web role.
async function begin() {
  const db = state.db!
  await db.exec('BEGIN;SET LOCAL ROLE personal_photos_app')
  for (const [k, v] of Object.entries({
    username: state.user,
    can_write: 'true',
    main_admin: String(state.mainAdmin),
  }))
    await db.query('SELECT set_config($1,$2,true)', ['photos.' + k, v])
}
async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (state.inTx) return fn()
  await begin()
  state.inTx = true
  try {
    const result = await fn()
    await state.db!.exec('COMMIT')
    return result
  } catch (error) {
    await state.db!.exec('ROLLBACK')
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
import * as people from '@/lib/people'

const DANA = '22222222-2222-4222-8222-222222222222'
const GROUP = '33333333-3333-4333-8333-333333333333'
const BOBS = '44444444-4444-4444-8444-444444444444'
const admin = async (sql: string) => (await state.db!.query(sql)).rows as Record<string, any>[]
const assignment = async (face: number) =>
  (await admin(`SELECT person_id, status FROM face_assignments WHERE face_id=${face}`))[0] ?? null
const latest = async () => (await people.history())[0]
/** The People overview exactly as the API requests its first page. */
const overview = () => people.listPeople({ kind: 'all' })

async function reset() {
  await state.db!.exec(`RESET ROLE;
 TRUNCATE face_match_queue, face_corrections, face_rejections, face_assignments, face_people, faces, face_scan_queue, stage_cleanup RESTART IDENTITY CASCADE;
 INSERT INTO face_people(person_id,owner_username,name) VALUES('${DANA}','ALICE','Dana'),('${GROUP}','ALICE',NULL),('${BOBS}','BOB','Bobby');
 INSERT INTO faces(photo_id,owner_username,source,source_path,model_version,face_index,box_x,box_y,box_w,box_h,detection_score,quality,quality_ok,embedding,crop_path)
 SELECT p, CASE WHEN p=9 THEN 'BOB' ELSE 'ALICE' END,'detected','o/'||p,'m',i,0.1+i*0.4,0.1,0.2,0.2,0.9,0.5+p*0.01,true,'[1,0]',
   'faces/00000000-0000-4000-8000-'||lpad((p*10+i)::text,12,'0')||'.webp'
 FROM (VALUES(1,0),(1,1),(2,0),(3,0),(4,0),(5,0),(9,0)) v(p,i);
 INSERT INTO face_assignments(face_id,person_id,owner_username,status,score) VALUES
  (1,'${DANA}','ALICE','confirmed',NULL),(3,'${DANA}','ALICE','auto',0.7),(4,'${DANA}','ALICE','suggested',0.5),
  (2,'${GROUP}','ALICE','auto',0.8),(5,'${GROUP}','ALICE','auto',0.8),(7,'${BOBS}','BOB','confirmed',NULL);
 UPDATE face_people SET cover_face_id=1 WHERE person_id='${DANA}';`)
}

beforeAll(async () => {
  state.db = await createTestDatabase({
    extensions: true,
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
 GRANT SELECT,INSERT,UPDATE,DELETE ON events,photos,album_shares,album_public_links,stage_cleanup TO personal_photos_app;
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES
  (1,1,'A','a','ALICE','PRIVATE'),(2,2,'B','b','BOB','PRIVATE');
 INSERT INTO album_shares(event_id,username,created_by) VALUES(1,'CAROL','ALICE');
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path)
  SELECT p, CASE WHEN p=9 THEN 2 ELSE 1 END, p||'.jpg','photo','READY','o/'||p FROM unnest(ARRAY[1,2,3,4,5,6,9]) p;`,
      },
      'setup/72-app-rls.sql',
      '202610072000_people_faces',
      '202610072010_people_worker_queue',
      '202610072100_people_publish_fix',
      '202610072200_people_merge_unnamed',
      '202610080900_people_delete_history',
      '202610201400_people_candidate_matching',
      '202610201500_people_confirmed_references',
      '202611142300_people_counts',
      {
        sql: `INSERT INTO face_settings(owner_username,enabled) VALUES('ALICE',true),('BOB',true)`,
      },
    ],
  })
}, 60000)
afterAll(async () => state.db?.close())
beforeEach(async () => {
  state.user = 'ALICE'
  await reset()
})

describe('reading people', () => {
  it('lets the owner review every page and reject a confirmed match beyond the first 200', async () => {
    await admin(`WITH added AS (
      INSERT INTO faces(photo_id,owner_username,source,source_path,model_version,face_index,
        box_x,box_y,box_w,box_h,detection_score,quality,quality_ok,embedding)
      SELECT 1,'ALICE','detected','o/1','m',100+i,0.1,0.1,0.2,0.2,0.9,0.5,true,'[1,0]'
      FROM generate_series(1,405) i RETURNING face_id
    ) INSERT INTO face_assignments(face_id,person_id,owner_username,status)
      SELECT face_id,'${DANA}','ALICE','confirmed' FROM added`)
    const first = await people.getPerson(DANA)
    const second = await people.getPerson(DANA, 200)
    const last = await people.getPerson(DANA, 400)
    expect([first.faces.length, second.faces.length, last.faces.length]).toEqual([200, 200, 8])
    expect([first.more, second.more, last.more]).toEqual([true, true, false])
    const all = [...first.faces, ...second.faces, ...last.faces]
    expect(new Set(all.map((f) => f.faceId)).size).toBe(408)
    expect(all.some((f) => f.photoId === 9)).toBe(false)
    const bad = last.faces.find((f) => f.status === 'confirmed')!
    await people.rejectFaces(DANA, [bad.faceId])
    expect(await assignment(bad.faceId)).toBeNull()
    expect(await admin(`SELECT face_id FROM face_rejections WHERE face_id=${bad.faceId}`)).toEqual([
      { face_id: bad.faceId },
    ])
  })
  it('uses the same live counts after ignoring a suggested face and undoing it', async () => {
    await people.setIgnored([4], true)
    expect((await people.getPerson(DANA)).person).toMatchObject({ photoCount: 2, reviewCount: 0 })
    expect(await overview()).toMatchObject({ reviewCount: 0, ignoredCount: 1 })
    await people.undo((await latest()).id)
    expect((await people.getPerson(DANA)).person).toMatchObject({ photoCount: 2, reviewCount: 1 })
    expect(await overview()).toMatchObject({ reviewCount: 1, ignoredCount: 0 })
  })
  it('lists named and unnamed people with counts, review and unknown totals', async () => {
    const list = await overview()
    expect(list.named).toEqual([
      expect.objectContaining({ personId: DANA, name: 'Dana', photoCount: 2, reviewCount: 1 }),
    ])
    expect(list.unnamed).toEqual([expect.objectContaining({ personId: GROUP, photoCount: 2 })])
    expect(list).toMatchObject({ reviewCount: 1, unknownCount: 1, ignoredCount: 0 })
    expect(JSON.stringify(list)).not.toContain('Bobby')
  })
  it('shows a person’s faces with suggestions first, and the review and unknown lists', async () => {
    const { faces } = await people.getPerson(DANA)
    expect(faces.map((f) => [f.faceId, f.status])).toEqual([
      [4, 'suggested'],
      [3, 'auto'],
      [1, 'confirmed'],
    ])
    expect((await people.reviewQueue()).faces).toEqual([
      expect.objectContaining({ faceId: 4, personName: 'Dana' }),
    ])
    expect((await people.unknownFaces()).faces.map((f) => f.faceId)).toEqual([6])
    await expect(people.getPerson(BOBS)).rejects.toMatchObject({ status: 404 })
  })
  it('includes lower-confidence unknown faces and supports tagging, ignore, and undo', async () => {
    await admin('UPDATE faces SET quality_ok=false WHERE face_id=6')
    expect(await overview()).toMatchObject({ unknownCount: 1, lowerConfidenceCount: 1 })
    expect((await people.unknownFaces()).faces).toEqual([
      expect.objectContaining({ faceId: 6, qualityOk: false }),
    ])
    expect((await people.unknownFaces(0, false, 'higher')).faces).toEqual([])
    expect((await people.unknownFaces(0, false, 'lower')).faces.map((f) => f.faceId)).toEqual([6])
    const tagged = await people.assignToPerson({ faceIds: [6], personId: DANA })
    expect(await assignment(6)).toMatchObject({ person_id: DANA, status: 'confirmed' })
    expect((await people.unknownFaces()).faces).toEqual([])
    expect((await admin('SELECT quality_ok FROM faces WHERE face_id=6'))[0].quality_ok).toBe(false)
    await people.undo(tagged.correctionId)
    await people.setIgnored([6], true)
    expect(await overview()).toMatchObject({
      unknownCount: 0,
      lowerConfidenceCount: 0,
      ignoredCount: 1,
    })
    expect((await people.unknownFaces(0, true)).faces.map((f) => f.faceId)).toEqual([6])
    await people.setIgnored([6], false)
    expect((await people.unknownFaces(0, false, 'lower')).faces.map((f) => f.faceId)).toEqual([6])
    state.user = 'BOB'
    expect((await people.unknownFaces()).faces).toEqual([])
    expect((await overview()).lowerConfidenceCount).toBe(0)
  })
  it('paginates lower-confidence faces and excludes assigned and ignored detections', async () => {
    await admin(`INSERT INTO faces(photo_id,owner_username,source,source_path,model_version,face_index,box_x,box_y,box_w,box_h,detection_score,quality,quality_ok,embedding)
      SELECT 6,'ALICE','detected','o/6','m',i,0.1,0.1,0.2,0.2,0.8,0.3,false,'[1,0]'
      FROM generate_series(0,200) i`)
    await admin('UPDATE faces SET quality_ok=false WHERE face_id IN (1,7)')
    const first = await people.unknownFaces(0, false, 'lower')
    const second = await people.unknownFaces(200, false, 'lower')
    expect(first.faces).toHaveLength(200)
    expect(first.more).toBe(true)
    expect(second.faces).toHaveLength(1)
    expect(second.more).toBe(false)
    expect(new Set([...first.faces, ...second.faces].map((f) => f.faceId)).size).toBe(201)
    expect((await people.unknownFaces(0, false, 'higher')).faces.map((f) => f.faceId)).toEqual([6])
    expect(await overview()).toMatchObject({
      unknownCount: 202,
      lowerConfidenceCount: 201,
    })
    await expect(people.unknownFaces(0, false, 'invalid')).rejects.toMatchObject({ status: 400 })
  })
  it('gives owners every face in a photo and shared viewers only shared, settled names', async () => {
    const own = await people.photoPeople(1)
    expect(own.canEdit).toBe(true)
    expect(own.faces.map((f) => f.personName)).toEqual(['Dana', null])
    expect(own.faces[0]).toHaveProperty('box')
    state.user = 'CAROL'
    expect((await people.photoPeople(1)).faces).toEqual([])
    await admin(`UPDATE face_settings SET share_names=true WHERE owner_username='ALICE'`)
    const shared = await people.photoPeople(1)
    expect(shared.canEdit).toBe(false)
    expect(shared.faces).toEqual([{ faceId: 1, hasCrop: true, personId: DANA, personName: 'Dana' }])
    expect((await people.photoPeople(4)).faces).toEqual([])
    await admin(`UPDATE face_settings SET share_names=false WHERE owner_username='ALICE'`)
  })
})

describe('corrections and undo', () => {
  it('resolves an off-page existing move name on the server and preserves undo', async () => {
    const result = await people.movePersonFaces(GROUP, [2], ' DANA ')
    expect(result.personId).toBe(DANA)
    expect(await assignment(2)).toEqual({ person_id: DANA, status: 'confirmed' })
    expect(await admin('SELECT * FROM face_rejections')).toEqual([])
    await people.undo(result.correctionId)
    expect(await assignment(2)).toEqual({ person_id: GROUP, status: 'auto' })
  })
  it('keeps split rejection and undo when a typed move name is genuinely new', async () => {
    const result = await people.movePersonFaces(DANA, [3], 'New name')
    expect(result.personId).not.toBe(DANA)
    expect(
      (await admin(`SELECT person_id FROM face_rejections WHERE face_id=3`))[0].person_id,
    ).toBe(DANA)
    await people.undo(result.correctionId)
    expect(await assignment(3)).toEqual({ person_id: DANA, status: 'auto' })
    expect(await admin(`SELECT 1 FROM face_people WHERE name='New name'`)).toEqual([])
  })
  it('refuses ambiguous typed names instead of selecting a legacy duplicate', async () => {
    await admin(`INSERT INTO face_people(owner_username,name) VALUES('ALICE','dana')`)
    await expect(people.movePersonFaces(GROUP, [2], 'Dana')).rejects.toMatchObject({ status: 409 })
    await expect(people.assignToPerson({ faceIds: [6], name: 'DANA' })).rejects.toMatchObject({
      status: 409,
    })
    expect(await assignment(2)).toEqual({ person_id: GROUP, status: 'auto' })
    expect(await people.history()).toEqual([])
    // An explicit selection identifies the intended record even if names are duplicated.
    expect((await people.assignToPerson({ faceIds: [6], personId: DANA })).personId).toBe(DANA)
  })
  it('does not move to the same, hidden or another owner’s identity', async () => {
    await expect(people.movePersonFaces(DANA, [3], 'Dana')).rejects.toMatchObject({ status: 409 })
    await admin(`UPDATE face_people SET hidden=true WHERE person_id='${DANA}'`)
    await expect(people.movePersonFaces(GROUP, [2], 'Dana')).rejects.toMatchObject({ status: 409 })
    await expect(people.movePersonFaces(BOBS, [7], 'New name')).rejects.toMatchObject({
      status: 404,
    })
    await expect(people.movePersonFaces(GROUP, [3], 'New name')).rejects.toMatchObject({
      status: 409,
    })
    expect(await admin(`SELECT 1 FROM face_people WHERE name='New name'`)).toEqual([])
  })
  it('renames, refuses duplicate names, and undoes', async () => {
    await people.renamePerson(GROUP, ' Sam  Lee ')
    expect((await admin(`SELECT name FROM face_people WHERE person_id='${GROUP}'`))[0].name).toBe(
      'Sam Lee',
    )
    await expect(people.renamePerson(GROUP, 'dana')).rejects.toMatchObject({ status: 409 })
    await expect(people.renamePerson(GROUP, '<b>')).rejects.toMatchObject({ status: 400 })
    await people.undo((await latest()).id)
    expect(
      (await admin(`SELECT name FROM face_people WHERE person_id='${GROUP}'`))[0].name,
    ).toBeNull()
  })
  it('confirms matches and refuses faces that are not the person’s', async () => {
    await people.confirmFaces(DANA, [4])
    expect(await assignment(4)).toEqual({ person_id: DANA, status: 'confirmed' })
    await expect(people.confirmFaces(DANA, [2])).rejects.toMatchObject({ status: 409 })
  })
  it('"Not this person" removes the match and keeps the scanner from re-adding it', async () => {
    await people.rejectFaces(DANA, [3])
    expect(await assignment(3)).toBeNull()
    await state.db!.exec('SET ROLE personal_photos_face_worker')
    await expect(
      admin(
        `INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES(3,'${DANA}','ALICE','auto')`,
      ),
    ).rejects.toThrow(/rejected/)
    await state.db!.exec('RESET ROLE')
    await people.undo((await latest()).id)
    expect(await assignment(3)).toEqual({ person_id: DANA, status: 'auto' })
    expect(await admin('SELECT * FROM face_rejections')).toEqual([])
  })
  it('preserves a selected suggested cover when adding another face', async () => {
    await people.setCover(DANA, 4)
    await people.assignToPerson({ faceIds: [6], personId: DANA })
    expect(
      (await admin(`SELECT cover_face_id FROM face_people WHERE person_id='${DANA}'`))[0]
        .cover_face_id,
    ).toBe(4)
  })
  it('tags unknown faces by a new name and undo removes the new person', async () => {
    const { personId } = await people.assignToPerson({ faceIds: [6], name: 'Lee' })
    expect(await assignment(6)).toEqual({ person_id: personId, status: 'confirmed' })
    expect(
      (await admin(`SELECT cover_face_id FROM face_people WHERE person_id='${personId}'`))[0]
        .cover_face_id,
    ).toBe(6)
    await people.undo((await latest()).id)
    expect(await assignment(6)).toBeNull()
    expect(await admin(`SELECT 1 FROM face_people WHERE person_id='${personId}'`)).toEqual([])
  })
  it('tags by an existing name instead of creating a duplicate', async () => {
    expect((await people.assignToPerson({ faceIds: [6], name: 'DANA' })).personId).toBe(DANA)
  })
  it('merges an unnamed group into a named person, confirms settled matches, and undoes', async () => {
    await people.mergePeople(DANA, [GROUP])
    expect(
      (await admin(`SELECT cover_face_id FROM face_people WHERE person_id='${DANA}'`))[0]
        .cover_face_id,
    ).toBe(1)
    expect(await assignment(2)).toEqual({ person_id: DANA, status: 'confirmed' })
    expect(await assignment(4)).toEqual({ person_id: DANA, status: 'suggested' })
    expect(await admin(`SELECT 1 FROM face_people WHERE person_id='${GROUP}'`)).toEqual([])
    await people.undo((await latest()).id)
    expect(await assignment(2)).toEqual({ person_id: GROUP, status: 'auto' })
    expect(await assignment(3)).toEqual({ person_id: DANA, status: 'auto' })
    expect(
      (await admin(`SELECT cover_face_id FROM face_people WHERE person_id='${DANA}'`))[0]
        .cover_face_id,
    ).toBe(1)
  })
  it('keeps the named identity and cover even when an old client asks to keep the unnamed group', async () => {
    const result = await people.mergePeople(GROUP, [DANA])
    expect(result.personId).toBe(DANA)
    expect(
      (await admin(`SELECT name, cover_face_id FROM face_people WHERE person_id='${DANA}'`))[0],
    ).toEqual({ name: 'Dana', cover_face_id: 1 })
    expect(await admin(`SELECT 1 FROM face_people WHERE person_id='${GROUP}'`)).toEqual([])
    await people.undo((await latest()).id)
    expect(await assignment(2)).toMatchObject({ person_id: GROUP })
    expect(
      (await admin(`SELECT cover_face_id FROM face_people WHERE person_id='${DANA}'`))[0]
        .cover_face_id,
    ).toBe(1)
    await reset()
    await people.renamePerson(GROUP, 'Sam')
    await expect(people.mergePeople(GROUP, [DANA])).rejects.toMatchObject({ status: 409 })
    await expect(people.mergePeople(DANA, [BOBS])).rejects.toMatchObject({ status: 404 })
  })
  it('splits faces into a new person, keeps them off the original, and undoes', async () => {
    const { personId } = await people.splitPerson(DANA, [3], 'Dana’s sister')
    expect(await assignment(3)).toEqual({ person_id: personId, status: 'confirmed' })
    expect(await assignment(1)).toEqual({ person_id: DANA, status: 'confirmed' })
    expect(await admin(`SELECT face_id FROM face_rejections WHERE person_id='${DANA}'`)).toEqual([
      { face_id: 3 },
    ])
    await people.undo((await latest()).id)
    expect(await assignment(3)).toEqual({ person_id: DANA, status: 'auto' })
    expect(await admin(`SELECT 1 FROM face_people WHERE name='Dana’s sister'`)).toEqual([])
  })
  it('ignores faces, moves the cover, and restores on undo', async () => {
    await people.setIgnored([1], true)
    expect(
      (await admin(`SELECT cover_face_id FROM face_people WHERE person_id='${DANA}'`))[0]
        .cover_face_id,
    ).toBe(3)
    expect((await overview()).ignoredCount).toBe(1)
    await people.undo((await latest()).id)
    expect((await admin('SELECT ignored FROM faces WHERE face_id=1'))[0].ignored).toBe(false)
    expect(
      (await admin(`SELECT cover_face_id FROM face_people WHERE person_id='${DANA}'`))[0]
        .cover_face_id,
    ).toBe(1)
  })
  it('ignores an entire hidden group and restores its faces, hidden state and cover on undo', async () => {
    await people.setHidden(DANA, true)
    const before = await admin(`SELECT face_id,ignored FROM faces ORDER BY face_id`)
    const result = await people.ignorePerson(DANA)
    expect(result.faces).toBeGreaterThan(1)
    expect(
      await admin(
        `SELECT f.face_id FROM faces f JOIN face_assignments a USING(face_id) WHERE a.person_id='${DANA}' AND NOT f.ignored`,
      ),
    ).toEqual([])
    expect((await admin('SELECT ignored FROM faces WHERE face_id=2'))[0].ignored).toBe(false)
    await people.undo(result.correctionId)
    expect(await admin(`SELECT face_id,ignored FROM faces ORDER BY face_id`)).toEqual(before)
    expect(
      (await admin(`SELECT hidden,cover_face_id FROM face_people WHERE person_id='${DANA}'`))[0],
    ).toEqual({ hidden: true, cover_face_id: 1 })
    await expect(people.ignorePerson(BOBS)).rejects.toMatchObject({ status: 404 })
  })
  it('hides a person and sets a cover only from their own faces', async () => {
    await people.setHidden(GROUP, true)
    expect((await overview()).hidden.map((p) => p.personId)).toEqual([GROUP])
    await people.setCover(DANA, 3)
    await expect(people.setCover(DANA, 2)).rejects.toMatchObject({ status: 400 })
  })
  it('tags a missed face with a box or name only, never on another owner’s photo', async () => {
    const boxed = await people.tagPhoto(6, {
      personId: DANA,
      box: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 },
    })
    const named = await people.tagPhoto(6, { name: 'Lee', box: null })
    expect(
      await admin(
        `SELECT source, box_x IS NULL AS no_box, created_by FROM faces WHERE face_id IN (${boxed.faceId},${named.faceId}) ORDER BY face_id`,
      ),
    ).toEqual([
      { source: 'manual', no_box: false, created_by: 'ALICE' },
      { source: 'manual', no_box: true, created_by: 'ALICE' },
    ])
    await expect(people.tagPhoto(9, { personId: DANA })).rejects.toMatchObject({ status: 404 })
    // A main admin may edit Bob's album, yet cannot tag their own people on Bob's photo;
    // this is a clean refusal that leaves no face behind, not a database error.
    const facesBefore = await admin('SELECT count(*)::int AS n FROM faces')
    state.mainAdmin = true
    try {
      await expect(people.tagPhoto(9, { personId: DANA })).rejects.toMatchObject({ status: 404 })
      await expect(people.tagPhoto(9, { name: 'Lee', box: null })).rejects.toMatchObject({
        status: 404,
      })
    } finally {
      state.mainAdmin = false
    }
    expect(await admin('SELECT count(*)::int AS n FROM faces')).toEqual(facesBefore)
    await expect(
      people.tagPhoto(6, { personId: DANA, box: { x: 0.9, y: 0, w: 0.2, h: 0.1 } }),
    ).rejects.toMatchObject({ status: 400 })
    await people.undo((await latest()).id)
    expect(await admin(`SELECT 1 FROM faces WHERE face_id=${named.faceId}`)).toEqual([])
    expect(await admin(`SELECT 1 FROM face_people WHERE name='Lee'`)).toEqual([])
  })
  it('undoes only the newest change, once', async () => {
    await people.renamePerson(GROUP, 'One')
    const first = (await latest()).id
    await people.renamePerson(GROUP, 'Two')
    await expect(people.undo(first)).rejects.toMatchObject({ status: 409 })
    const history = await people.history()
    expect(history.map((h) => h.canUndo)).toEqual([true, false])
    await people.undo(history[0].id)
    await expect(people.undo(history[0].id)).rejects.toMatchObject({ status: 409 })
    await people.undo(first)
    expect(
      (await admin(`SELECT name FROM face_people WHERE person_id='${GROUP}'`))[0].name,
    ).toBeNull()
  })
})

describe('permissions and settings', () => {
  it('lets no one else correct an owner’s people, including shared viewers', async () => {
    await admin(`UPDATE face_settings SET share_names=true WHERE owner_username='ALICE'`)
    for (const user of ['CAROL', 'BOB']) {
      state.user = user
      await expect(people.renamePerson(DANA, 'X')).rejects.toMatchObject({ status: 404 })
      await expect(people.rejectFaces(DANA, [1])).rejects.toMatchObject({ status: 404 })
      await expect(people.assignToPerson({ faceIds: [6], name: 'X' })).rejects.toMatchObject({
        status: 404,
      })
      await expect(people.tagPhoto(1, { name: 'X' })).rejects.toMatchObject({ status: 404 })
    }
    state.user = 'ALICE'
    expect(await assignment(1)).toEqual({ person_id: DANA, status: 'confirmed' })
    await admin(`UPDATE face_settings SET share_names=false WHERE owner_username='ALICE'`)
  })
  it('updates settings with validation', async () => {
    expect(await people.updateSettings({ shareNames: true })).toEqual({
      enabled: true,
      shareNames: true,
    })
    await expect(people.updateSettings({ enabled: 'yes' })).rejects.toMatchObject({ status: 400 })
    await people.updateSettings({ shareNames: false })
  })
  it('deletes all of the owner’s face data, queues crops, and leaves others untouched', async () => {
    await people.renamePerson(GROUP, 'Sam')
    expect(await people.deleteFaceData()).toEqual({ faces: 6 })
    for (const table of ['faces', 'face_people', 'face_assignments', 'face_corrections'])
      expect(
        await admin(`SELECT count(*)::int AS n FROM ${table} WHERE owner_username='ALICE'`),
      ).toEqual([{ n: 0 }])
    expect(
      (await admin(`SELECT count(*)::int AS n FROM stage_cleanup WHERE path LIKE 'faces/%'`))[0].n,
    ).toBe(6)
    expect(await people.getSettings()).toEqual({ enabled: false, shareNames: false })
    expect(await admin(`SELECT name FROM face_people WHERE owner_username='BOB'`)).toEqual([
      { name: 'Bobby' },
    ])
    await admin(`UPDATE face_settings SET enabled=true WHERE owner_username='ALICE'`)
  })
})

describe('bulk group decisions', () => {
  const GROUP2 = '55555555-5555-4555-8555-555555555555'
  const addGroup = async () => {
    await state.db!
      .exec(`INSERT INTO face_people(person_id,owner_username) VALUES('${GROUP2}','ALICE');
      INSERT INTO face_assignments(face_id,person_id,owner_username,status,score) VALUES(6,'${GROUP2}','ALICE','suggested',0.4)`)
  }
  it('assigns multiple groups atomically while preserving suggestions and rejections, with one Undo', async () => {
    await addGroup()
    await admin(
      `INSERT INTO face_rejections(face_id,person_id,owner_username) VALUES(5,'${DANA}','ALICE')`,
    )
    const changed = await people.changeGroups({
      action: 'assign',
      groupIds: [GROUP, GROUP2],
      personId: DANA,
    })
    expect(await assignment(2)).toMatchObject({ person_id: DANA, status: 'confirmed' })
    expect(await assignment(5)).toBeNull()
    expect(await assignment(6)).toMatchObject({ person_id: DANA, status: 'suggested' })
    expect(
      await admin(`SELECT person_id FROM face_people WHERE person_id IN ('${GROUP}','${GROUP2}')`),
    ).toEqual([])
    expect(await people.history()).toHaveLength(1)
    await people.undo(changed.correctionId)
    expect(await assignment(2)).toMatchObject({ person_id: GROUP, status: 'auto' })
    expect(await assignment(5)).toMatchObject({ person_id: GROUP, status: 'auto' })
    expect(await assignment(6)).toMatchObject({ person_id: GROUP2, status: 'suggested' })
  })
  it('ignores every face of multiple groups with one Undo', async () => {
    await addGroup()
    const result = await people.changeGroups({ action: 'ignore', groupIds: [GROUP, GROUP2] })
    expect(await admin('SELECT face_id FROM faces WHERE ignored ORDER BY face_id')).toEqual([
      { face_id: 2 },
      { face_id: 5 },
      { face_id: 6 },
    ])
    await people.undo(result.correctionId)
    expect(await admin('SELECT face_id FROM faces WHERE ignored')).toEqual([])
  })
  it('rolls back the whole batch for foreign, missing, or newly named groups', async () => {
    for (const groups of [
      [GROUP, BOBS],
      [GROUP, GROUP2],
      [GROUP, DANA],
    ]) {
      await expect(
        people.changeGroups({ action: 'ignore', groupIds: groups }),
      ).rejects.toMatchObject({ status: expect.any(Number) })
      expect(await admin('SELECT face_id FROM faces WHERE ignored')).toEqual([])
      expect(await people.history()).toHaveLength(0)
    }
    await expect(
      people.changeGroups({ action: 'assign', groupIds: [GROUP], personId: BOBS }),
    ).rejects.toMatchObject({ status: 404 })
  })
  it('creates a new named destination and restores groups on Undo', async () => {
    await addGroup()
    const result = await people.changeGroups({
      action: 'assign',
      groupIds: [GROUP, GROUP2],
      name: 'New Person',
    })
    const a = await assignment(2)
    expect(a?.person_id).not.toBe(GROUP)
    expect(await admin(`SELECT name FROM face_people WHERE person_id='${a!.person_id}'`)).toEqual([
      { name: 'New Person' },
    ])
    await people.undo(result.correctionId)
    expect(await assignment(2)).toMatchObject({ person_id: GROUP })
    expect(await admin("SELECT person_id FROM face_people WHERE name='New Person'")).toEqual([])
  })
})

it('offers ignored faces separately to the owner without changing shared visibility', async () => {
  await people.ignorePerson(DANA)
  const own = await people.photoPeople(1)
  expect(own.faces.map((f) => f.faceId)).not.toContain(1)
  expect(own.ignoredFaces).toEqual([
    expect.objectContaining({ faceId: 1, ignored: true, personName: 'Dana', hasCrop: true }),
  ])
  await admin(`UPDATE face_settings SET share_names=true WHERE owner_username='ALICE'`)
  state.user = 'CAROL'
  const shared = await people.photoPeople(1)
  expect(shared.ignoredFaces).toEqual([])
  expect(shared.faces.map((f) => f.faceId)).not.toContain(1)
  await expect(people.setIgnored([1], false)).rejects.toThrow()
})
it('restores just the selected ignored face and preserves its previous assignment', async () => {
  await people.ignorePerson(DANA)
  await people.setIgnored([1], false)
  expect((await people.photoPeople(1)).faces).toContainEqual(
    expect.objectContaining({ faceId: 1, personName: 'Dana' }),
  )
  expect((await admin('SELECT ignored FROM faces WHERE face_id=3'))[0].ignored).toBe(true)
  expect(await assignment(1)).toMatchObject({ person_id: DANA, status: 'confirmed' })
})
it('assigns an ignored face to an existing or new person and restores it atomically', async () => {
  await people.setIgnored([2], true)
  await people.assignToPerson({ faceIds: [2], personId: DANA })
  expect((await people.photoPeople(1)).faces).toContainEqual(
    expect.objectContaining({ faceId: 2, personName: 'Dana', status: 'confirmed' }),
  )
  await people.setIgnored([2], true)
  await people.assignToPerson({ faceIds: [2], name: 'New friend' })
  const result = await people.photoPeople(1)
  expect(result.ignoredFaces).toEqual([])
  expect(result.faces).toContainEqual(
    expect.objectContaining({ faceId: 2, personName: 'New friend', status: 'confirmed' }),
  )
})

async function seedCursorFaces() {
  await state.db!.exec(`INSERT INTO faces(photo_id,owner_username,source,created_by,quality)
    SELECT 1+(i%5),'ALICE','manual','ALICE',CASE WHEN i%7=0 THEN NULL ELSE (i%3)*0.25 END
    FROM generate_series(1,900) i;
    INSERT INTO face_assignments(face_id,person_id,owner_username,status,score)
    SELECT face_id,CASE WHEN face_id%2=0 THEN '${DANA}'::uuid ELSE '${GROUP}'::uuid END,'ALICE',
      CASE WHEN face_id%7=0 THEN 'confirmed' ELSE 'suggested' END,
      CASE WHEN face_id%5=0 THEN NULL ELSE (face_id%3)*0.25 END FROM faces WHERE face_id>7;`)
}
it('keyset pages person and review faces with ties and nulls without omitting or repeating faces', async () => {
  await seedCursorFaces()
  for (const mode of ['person', 'review']) {
    const expected = await admin(
      mode === 'person'
        ? `SELECT f.face_id FROM face_assignments a JOIN faces f USING(face_id) JOIN photos ph ON ph.photo_id=f.photo_id WHERE a.person_id='${DANA}' AND NOT f.ignored ORDER BY (a.status='suggested') DESC,ph.date_taken DESC NULLS LAST,f.face_id DESC`
        : `SELECT f.face_id FROM face_assignments a JOIN faces f USING(face_id) JOIN face_people p ON p.person_id=a.person_id JOIN photos ph ON ph.photo_id=f.photo_id WHERE a.owner_username='ALICE' AND a.status='suggested' AND NOT f.ignored ORDER BY lower(p.name) NULLS LAST,p.person_id,a.score DESC NULLS LAST,f.face_id`,
    )
    const actual: number[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const result: Awaited<ReturnType<typeof people.reviewQueue>> =
        mode === 'person'
          ? await people.getPerson(DANA, undefined, cursor)
          : await people.reviewQueue(undefined, cursor)
      actual.push(...result.faces.map((f) => f.faceId))
      expect(result.faces).toHaveLength(Math.min(200, expected.length - pages * 200))
      expect(result.faces.every((f) => !('_cursor' in f))).toBe(true)
      cursor = result.nextCursor
      pages++
      expect(pages).toBeLessThan(10)
    } while (cursor)
    expect(actual).toEqual(expected.map((r) => r.face_id))
  }
})
it('unknown cursors survive deletion before the boundary and reject mismatched filters', async () => {
  await seedCursorFaces()
  await admin('DELETE FROM face_assignments WHERE face_id>7')
  const first = await people.unknownFaces()
  expect(first.nextCursor).toBeTruthy()
  const expected = (
    await admin(
      `SELECT f.face_id FROM faces f JOIN photos ph ON ph.photo_id=f.photo_id WHERE f.owner_username='ALICE' AND NOT f.ignored AND NOT EXISTS(SELECT FROM face_assignments a WHERE a.face_id=f.face_id) ORDER BY f.quality DESC NULLS LAST,f.face_id DESC`,
    )
  ).slice(200, 400)
  await admin(`DELETE FROM faces WHERE face_id=${first.faces[0].faceId}`)
  const second = await people.unknownFaces(undefined, false, 'all', first.nextCursor)
  expect(second.faces.map((f) => f.faceId)).toEqual(expected.map((r) => r.face_id))
  await expect(people.unknownFaces(undefined, true, 'all', first.nextCursor)).rejects.toMatchObject(
    { status: 400 },
  )
  state.user = 'BOB'
  expect((await people.unknownFaces(undefined, false, 'all', first.nextCursor)).faces).toEqual([])
})

it('can omit repeated person counts while retaining ownership checks and the same face page', async () => {
  const full = await people.getPerson(DANA)
  const lean = await people.getPerson(DANA, undefined, undefined, false)
  expect(full.person).toBeDefined()
  expect(lean).not.toHaveProperty('person')
  expect(lean.faces).toEqual(full.faces)
  await expect(people.getPerson(BOBS, undefined, undefined, false)).rejects.toMatchObject({
    status: 404,
  })
})

it('pages every People category with live ownership and optional summary counts', async () => {
  await state.db!.exec(`INSERT INTO face_people(person_id,owner_username,name,hidden)
    SELECT md5('overview-'||i)::uuid,'ALICE',CASE WHEN i BETWEEN 211 AND 420 THEN NULL ELSE 'Overview '||lpad(i::text,3,'0') END,i>420 FROM generate_series(1,450) i;
    WITH f AS (INSERT INTO faces(photo_id,owner_username,source,source_path,model_version,face_index,box_x,box_y,box_w,box_h,detection_score,quality,quality_ok,embedding)
    SELECT 1,'ALICE','detected','o/1','overview',i,0.1,0.1,0.2,0.2,0.9,0.9,true,'[1,0]' FROM generate_series(1,450) i RETURNING face_id,face_index)
    INSERT INTO face_assignments(face_id,person_id,owner_username,status)
    SELECT face_id,md5('overview-'||face_index)::uuid,'ALICE','confirmed' FROM f;`)
  const totals = await people.listPeople({ kind: 'none' })
  expect(totals.peopleCount).toBe(452)
  expect(totals.unnamedCount).toBe(211)
  // Independent of paging: every person Alice owns, read straight from the table.
  const stored = (
    await admin(`SELECT person_id,name,hidden FROM face_people WHERE owner_username='ALICE'`)
  ).map((p) => ({ personId: p.person_id as string, name: p.name, hidden: p.hidden }))
  const full = {
    named: stored.filter((p) => p.name && !p.hidden),
    unnamed: stored.filter((p) => !p.name && !p.hidden),
    hidden: stored.filter((p) => p.hidden),
  }
  for (const kind of ['named', 'unnamed', 'hidden', 'all']) {
    const expected =
      kind === 'all'
        ? [...full.named, ...full.unnamed, ...full.hidden]
        : full[kind as 'named' | 'unnamed' | 'hidden']
    const seen: string[] = []
    let cursor: string | null | undefined
    do {
      const page = await people.listPeople({ kind, cursor, includeTotals: false })
      const shown = [...page.named, ...page.unnamed, ...page.hidden]
      expect(shown.length).toBeLessThanOrEqual(200)
      expect(page.reviewCount).toBeUndefined()
      seen.push(...shown.map((p) => p.personId))
      cursor = page.nextCursor
    } while (cursor && seen.length < 1000)
    expect(cursor).toBeNull()
    expect(seen.length).toBe(expected.length)
    expect(new Set(seen)).toEqual(new Set(expected.map((p) => p.personId)))
  }
  const first = await people.listPeople({ kind: 'named' })
  await expect(people.listPeople({ kind: 'hidden', cursor: first.nextCursor })).rejects.toThrow(
    'Invalid face page cursor',
  )
  state.user = 'BOB'
  const other = await people.listPeople({ kind: 'named', cursor: first.nextCursor })
  expect(other.named).toEqual([])
  expect(other.peopleCount).toBe(1)
  state.user = 'ALICE'
  const counts = await people.listPeople({ kind: 'none' })
  expect([...counts.named, ...counts.unnamed, ...counts.hidden]).toEqual([])
  expect(counts.peopleCount).toBe(452)
})
