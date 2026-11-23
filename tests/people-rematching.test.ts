import { createTestDatabase } from './fixtures/test-database'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const RUN = '44444444-4444-4444-8444-444444444444'
const DANA = '22222222-2222-4222-8222-222222222222'
const KEITH = '55555555-5555-4555-8555-555555555555'
let db: PGlite

beforeAll(async () => {
  db = await createTestDatabase({
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
        sql: `SET search_path=public;
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username) VALUES(1,1,'Alice','a','ALICE'),(2,2,'Bob','b','BOB');`,
      },
      'setup/72-app-rls.sql',
      '202610072000_people_faces',
      '202610072010_people_worker_queue',
      '202610072100_people_publish_fix',
      '202610072200_people_merge_unnamed',
      '202610081100_people_stable_covers',
      '202610201400_people_candidate_matching',
      '202610201500_people_confirmed_references',
      '202610201600_people_named_group_rematching',
      '202610201700_people_nonblocking_requests',
      '202610211200_people_rematch_unnamed',
      '202611041600_face_matching_bounded_aggregation',
    ],
  })
}, 60000)
afterAll(async () => db?.close())

beforeEach(async () => {
  await db.exec(`TRUNCATE face_match_requests,face_match_queue,face_assignments,face_rejections,face_corrections,face_scan_queue,stage_cleanup;
 DELETE FROM face_people; DELETE FROM faces; DELETE FROM face_scan_runs; DELETE FROM photos; DELETE FROM face_settings;
 INSERT INTO face_settings(owner_username,enabled) VALUES('ALICE',true),('BOB',true);
 INSERT INTO face_scan_runs(id,requested_by,kind,status,photo_limit) VALUES('${RUN}','ALICE','pilot','starting',100);
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path)
  SELECT g,CASE WHEN g<=8 THEN 1 ELSE 2 END,g||'.jpg','photo','READY','originals/'||g||'.jpg' FROM generate_series(1,10) g;
 UPDATE face_scan_queue SET run_id='${RUN}';`)
})

/** Runs statements as the restricted face worker database role. */
async function worker<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN;SET LOCAL ROLE personal_photos_face_worker')
  try {
    const result = await fn()
    await db.exec('COMMIT')
    return result
  } catch (error) {
    await db.exec('ROLLBACK')
    throw error
  }
}
const one = async <T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  options?: { paramTypes?: number[] },
) => (await db.query<T>(sql, params, options)).rows[0]
const face = (index: number, embedding: number[], extra: Record<string, unknown> = {}) => ({
  index,
  x: 0.1 + index * 0.3,
  y: 0.1,
  w: 0.2,
  h: 0.2,
  score: 0.95,
  quality: 0.9,
  quality_ok: true,
  embedding,
  crop_path: `faces/x/${index}-${embedding.join('_')}.webp`,
  ...extra,
})
async function publish(photo: number, faces: ReturnType<typeof face>[]) {
  const claimed = await worker(
    async () =>
      (
        await db.query<{ claim_token: string }>(
          `UPDATE face_scan_queue SET status='running',claim_token=gen_random_uuid(),lease_until=now()+interval '5 minutes'
       WHERE photo_id=$1 RETURNING claim_token`,
          [photo],
        )
      ).rows[0],
  )
  return worker(() =>
    one('SELECT face_worker.publish($1,$2,$3,$4,$5) n', [
      photo,
      claimed.claim_token,
      'sface-2021dec',
      `originals/${photo}.jpg`,
      JSON.stringify(faces),
    ]),
  )
}
const match = (owner = 'ALICE', auto = 0.8, review = 0.6) =>
  worker(() =>
    one<{ n: number }>("SELECT face_worker.match($1,'sface-2021dec',$2,$3) n", [
      owner,
      auto,
      review,
    ]),
  )
const assignment = (faceId: number) =>
  one<{ person_id: string; status: string; score: number }>(
    'SELECT person_id,status,score FROM face_assignments WHERE face_id=$1',
    [faceId],
  )
const faceId = async (photo: number, index = 0) =>
  (
    await one<{ face_id: number }>(
      'SELECT face_id FROM faces WHERE photo_id=$1 AND face_index=$2',
      [photo, index],
    )
  ).face_id

async function seedReferences() {
  await db.exec(
    `INSERT INTO face_people(person_id,owner_username,name) VALUES('${KEITH}','ALICE','Keith')`,
  )
  for (const photo of [1, 2, 3]) {
    await publish(photo, [face(0, [1, 0, 0], { quality_ok: false })])
    await db.query(
      `INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES($1,'${KEITH}','ALICE','confirmed')`,
      [await faceId(photo)],
    )
  }
}
async function batch(size = 100) {
  await db.exec('BEGIN;SET LOCAL ROLE personal_photos_maintenance')
  try {
    const result = await one('SELECT * FROM face_worker.rematch_batch($1)', [size])
    await db.exec('COMMIT')
    return result
  } catch (error) {
    await db.exec('ROLLBACK')
    throw error
  }
}

describe('confirmed reference rematching', () => {
  it('uses confirmed low-quality references, coalesces requests, and processes bounded batches without feedback', async () => {
    await seedReferences()
    expect(
      await one(
        'SELECT count(DISTINCT (owner_username,model_version))::int n FROM face_match_requests',
      ),
    ).toEqual({ n: 1 })
    await publish(4, [face(0, [0.81, 0, Math.sqrt(1 - 0.81 ** 2)], { quality_ok: false })])
    await publish(5, [face(0, [0.7, 0, Math.sqrt(0.51)], { quality_ok: false })])
    expect(await batch(1)).toMatchObject({ scanned: 1, matched: 1, remaining: true })
    expect(await assignment(await faceId(4))).toMatchObject({ person_id: KEITH, status: 'auto' })
    expect(await assignment(await faceId(5))).toBeUndefined()
    expect(await batch(1)).toMatchObject({ scanned: 1, matched: 1 })
    expect(await assignment(await faceId(5))).toMatchObject({
      person_id: KEITH,
      status: 'suggested',
    })
    expect(await batch()).toMatchObject({ scanned: 0, remaining: false })
    expect(await batch()).toBeUndefined()
    expect(await one('SELECT bool_or(quality_ok) AS promoted FROM faces')).toEqual({
      promoted: false,
    })
  })
  it('restarts the cursor when a new confirmation arrives and never replaces an existing label', async () => {
    await seedReferences()
    await publish(4, [face(0, [0, 1, 0], { quality_ok: false })])
    await publish(5, [face(0, [0, 1, 0], { quality_ok: false })])
    await batch()
    expect(await assignment(await faceId(4))).toBeUndefined()
    await db.query(
      `INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES($1,'${KEITH}','ALICE','confirmed')`,
      [await faceId(5)],
    )
    expect(await one('SELECT count(*)::int n FROM face_match_requests')).toEqual({ n: 1 })
    // The interactive request leaves worker progress alone until the next batch.
    expect(
      (await one<{ cursor: number }>('SELECT after_face_id::int AS cursor FROM face_match_queue'))!
        .cursor,
    ).toBeGreaterThan(0)
    await batch()
    expect(await assignment(await faceId(5))).toMatchObject({ status: 'confirmed' })
  })
  it('requires distinct reference photos and excludes the candidate photo', async () => {
    await db.exec(
      `INSERT INTO face_people(person_id,owner_username,name) VALUES('${KEITH}','ALICE','Keith')`,
    )
    await publish(1, [face(0, [1, 0, 0]), face(1, [1, 0, 0]), face(2, [1, 0, 0])])
    for (const index of [0, 1])
      await db.query(
        `INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES($1,'${KEITH}','ALICE','confirmed')`,
        [await faceId(1, index)],
      )
    await publish(4, [face(0, [1, 0, 0])])
    await batch()
    expect(await assignment(await faceId(1, 2))).toBeUndefined()
    expect(await assignment(await faceId(4))).toMatchObject({ status: 'suggested' })
  })
  it('does not use automatic labels as named references or cross owners', async () => {
    await seedReferences()
    await db.exec("UPDATE face_assignments SET status='auto'")
    await publish(4, [face(0, [1, 0, 0])])
    await batch()
    expect(await assignment(await faceId(4))).toBeUndefined()
    await db.exec("UPDATE face_assignments SET status='confirmed'")
    await publish(9, [face(0, [1, 0, 0])])
    await match('BOB')
    expect(await assignment(await faceId(9))).toBeUndefined()
  })
  it('respects ignores, rejections, hidden people, and disabled People', async () => {
    await seedReferences()
    await publish(4, [face(0, [1, 0, 0])])
    await publish(5, [face(0, [1, 0, 0])])
    await db.exec('UPDATE faces SET ignored=true WHERE photo_id=4')
    await db.query(
      `INSERT INTO face_rejections(face_id,person_id,owner_username) VALUES($1,'${KEITH}','ALICE')`,
      [await faceId(5)],
    )
    await batch()
    expect(await assignment(await faceId(4))).toBeUndefined()
    expect(await assignment(await faceId(5))).toBeUndefined()
    await db.exec("UPDATE face_settings SET enabled=false WHERE owner_username='ALICE'")
    expect(await batch()).toBeUndefined()
    expect(await one('SELECT count(*)::int n FROM face_match_requests')).toEqual({ n: 0 })
  })
  it('downgrades ambiguous identities even with three reference photos', async () => {
    await seedReferences()
    await db.exec(
      `INSERT INTO face_people(person_id,owner_username,name) VALUES('${DANA}','ALICE','Dana')`,
    )
    for (const photo of [5, 6, 7]) {
      await publish(photo, [face(0, [0.99, 0.1, 0], { quality_ok: false })])
      await db.query(
        `INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES($1,'${DANA}','ALICE','confirmed')`,
        [await faceId(photo)],
      )
    }
    await publish(4, [face(0, [1, 0, 0], { quality_ok: false })])
    await batch()
    expect(await assignment(await faceId(4))).toMatchObject({ status: 'suggested' })
  })
  it('bounds scan matching and queues the remainder with stricter configured thresholds', async () => {
    await seedReferences()
    await db.exec('TRUNCATE face_match_requests,face_match_queue')
    await db.exec(`INSERT INTO faces(photo_id,owner_username,source,source_path,model_version,face_index,box_x,box_y,box_w,box_h,detection_score,quality,quality_ok,embedding,crop_path)
      SELECT 4,'ALICE','detected','originals/4.jpg','sface-2021dec',g,0.1,0.1,0.2,0.2,0.9,0.8,false,'[1,0,0]','faces/test.webp'
      FROM generate_series(0,104) g`)
    expect(await match('ALICE', 0.9, 0.8)).toEqual({ n: 100 })
    expect(await one('SELECT auto_threshold,review_threshold FROM face_match_queue')).toEqual({
      auto_threshold: 0.9,
      review_threshold: 0.8,
    })
    expect(await batch()).toMatchObject({ scanned: 5, matched: 5 })
    expect(await batch()).toMatchObject({ remaining: false })
  })
  it('matches faces grouped after the first 100, without letting their own group compete', async () => {
    await seedReferences()
    await db.exec('TRUNCATE face_match_requests,face_match_queue')
    await db.exec(`INSERT INTO faces(photo_id,owner_username,source,source_path,model_version,face_index,box_x,box_y,box_w,box_h,detection_score,quality,quality_ok,embedding,crop_path)
      SELECT 4,'ALICE','detected','originals/4.jpg','sface-2021dec',g,0.1,0.1,0.2,0.2,0.9,0.8,true,'[1,0,0]','faces/test.webp'
      FROM generate_series(0,104) g`)
    expect(await match()).toEqual({ n: 100 })
    await db.exec(`INSERT INTO face_people(person_id,owner_username) VALUES('${DANA}','ALICE');
      INSERT INTO face_assignments(face_id,person_id,owner_username,status,score)
      SELECT f.face_id,'${DANA}','ALICE','auto',1 FROM faces f WHERE photo_id=4
      AND NOT EXISTS(SELECT FROM face_assignments a WHERE a.face_id=f.face_id)`)
    expect(await batch()).toMatchObject({ scanned: 5, matched: 5 })
    expect(
      await one(
        `SELECT count(*)::int n FROM face_assignments WHERE person_id='${KEITH}' AND status='auto'`,
      ),
    ).toEqual({ n: 105 })
    expect(await batch()).toMatchObject({ remaining: false })
  })
  it('preserves confirmed group labels, named assignments, hidden groups, ignored faces and rejected matches', async () => {
    await seedReferences()
    await db.exec(`INSERT INTO face_people(person_id,owner_username) VALUES('${DANA}','ALICE')`)
    for (const photo of [4, 5, 6, 7, 8]) {
      await publish(photo, [face(0, [1, 0, 0])])
      await db.query(
        `INSERT INTO face_assignments(face_id,person_id,owner_username,status)
        VALUES($1,'${DANA}','ALICE',$2)`,
        [await faceId(photo), photo === 4 ? 'confirmed' : 'auto'],
      )
    }
    await db.exec(`UPDATE faces SET ignored=true WHERE photo_id=5;
      INSERT INTO face_rejections(face_id,person_id,owner_username)
        SELECT face_id,'${KEITH}','ALICE' FROM faces WHERE photo_id=6;
      UPDATE face_assignments SET person_id='${KEITH}',status='suggested'
        WHERE face_id IN (SELECT face_id FROM faces WHERE photo_id=7)`)
    await batch()
    for (const photo of [4, 5, 6])
      expect(await assignment(await faceId(photo))).toMatchObject({ person_id: DANA })
    expect(await assignment(await faceId(7))).toMatchObject({
      person_id: KEITH,
      status: 'suggested',
    })
    expect(await assignment(await faceId(8))).toMatchObject({ person_id: KEITH, status: 'auto' })
    await db.exec(`UPDATE face_assignments SET person_id='${DANA}',status='auto' WHERE face_id IN (SELECT face_id FROM faces WHERE photo_id=8);
      UPDATE face_people SET hidden=true WHERE person_id='${DANA}';
      INSERT INTO face_match_requests(owner_username,model_version) VALUES('ALICE','sface-2021dec')`)
    await batch()
    expect(await assignment(await faceId(8))).toMatchObject({ person_id: DANA })
  })
  it('does not move grouped faces when named identities are ambiguous', async () => {
    await seedReferences()
    const group = '66666666-6666-4666-8666-666666666666'
    await db.exec(
      `INSERT INTO face_people(person_id,owner_username,name) VALUES('${DANA}','ALICE','Dana'),('${group}','ALICE',NULL)`,
    )
    for (const photo of [5, 6, 7]) {
      await publish(photo, [face(0, [0.99, 0.1, 0])])
      await db.query(
        `INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES($1,'${DANA}','ALICE','confirmed')`,
        [await faceId(photo)],
      )
    }
    await publish(4, [face(0, [1, 0, 0])])
    await db.query(
      `INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES($1,$2,'ALICE','auto')`,
      [await faceId(4), group],
    )
    expect(await batch()).toMatchObject({ matched: 0 })
    expect(await assignment(await faceId(4))).toMatchObject({ person_id: group, status: 'auto' })
  })
  it('keeps weak group matches in place and can rematch them when confirmed references improve', async () => {
    await seedReferences()
    await db.exec(`INSERT INTO face_people(person_id,owner_username) VALUES('${DANA}','ALICE')`)
    await publish(4, [face(0, [0.7, 0, Math.sqrt(0.51)])])
    await db.query(
      `INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES($1,'${DANA}','ALICE','auto')`,
      [await faceId(4)],
    )
    expect(await batch()).toMatchObject({ matched: 0 })
    expect(await assignment(await faceId(4))).toMatchObject({ person_id: DANA, status: 'auto' })
    await db.exec(`UPDATE faces SET embedding='[0.7,0,0.714142842854285]' WHERE photo_id IN (1,2,3);
      INSERT INTO face_match_requests(owner_username,model_version) VALUES('ALICE','sface-2021dec')`)
    expect(await batch()).toMatchObject({ matched: 1 })
    expect(await assignment(await faceId(4))).toMatchObject({ person_id: KEITH, status: 'auto' })
  })
  it('queues already-confirmed references when a group is named or unhidden', async () => {
    await seedReferences()
    await db.exec(
      `UPDATE face_people SET name=NULL WHERE person_id='${KEITH}';TRUNCATE face_match_requests,face_match_queue`,
    )
    await db.exec(
      "BEGIN;SET LOCAL ROLE personal_photos_app;SET LOCAL photos.username='ALICE';SET LOCAL photos.can_write='true'",
    )
    await db.exec(`UPDATE face_people SET name='Keith' WHERE person_id='${KEITH}'`)
    expect(
      await one(
        'SELECT count(DISTINCT (owner_username,model_version))::int n FROM face_match_requests',
      ),
    ).toEqual({ n: 1 })
    await db.exec('COMMIT;TRUNCATE face_match_requests,face_match_queue')
    await db.exec(`UPDATE face_people SET hidden=true WHERE person_id='${KEITH}'`)
    expect(await one('SELECT count(*)::int n FROM face_match_requests')).toEqual({ n: 0 })
    await db.exec(`UPDATE face_people SET hidden=false WHERE person_id='${KEITH}'`)
    expect(
      await one(
        'SELECT count(DISTINCT (owner_username,model_version))::int n FROM face_match_requests',
      ),
    ).toEqual({ n: 1 })
  })
  it('confirms without accessing the matcher progress table', async () => {
    await seedReferences()
    await db.exec('TRUNCATE face_match_requests,face_match_queue')
    await db.exec(`BEGIN;
      REVOKE ALL ON face_match_queue FROM personal_photos_app;
      SET LOCAL ROLE personal_photos_app;
      SET LOCAL photos.username='ALICE'; SET LOCAL photos.can_write='true';
      UPDATE face_assignments SET status='suggested';
      UPDATE face_assignments SET status='confirmed';`)
    expect(await one('SELECT count(*)::int n FROM face_match_requests')).toEqual({ n: 3 })
    await db.exec('ROLLBACK')
    expect(await one('SELECT count(*)::int n FROM face_match_requests')).toEqual({ n: 0 })
  })
  it('keeps queue writes scoped to the correcting owner and rolls requests back with corrections', async () => {
    await seedReferences()
    await db.exec('TRUNCATE face_match_requests,face_match_queue')
    await db.exec(
      "BEGIN;SET LOCAL ROLE personal_photos_app;SET LOCAL photos.username='ALICE';SET LOCAL photos.can_write='true'",
    )
    await expect(
      db.exec("INSERT INTO face_match_requests(owner_username,model_version) VALUES('BOB','m')"),
    ).rejects.toThrow()
    await db.exec('ROLLBACK')
    await db.exec(
      "BEGIN;SET LOCAL ROLE personal_photos_app;SET LOCAL photos.username='ALICE';SET LOCAL photos.can_write='true'",
    )
    await db.exec(
      "UPDATE face_assignments SET status='suggested';UPDATE face_assignments SET status='confirmed'",
    )
    expect(
      await one(
        'SELECT count(DISTINCT (owner_username,model_version))::int n FROM face_match_requests',
      ),
    ).toEqual({ n: 1 })
    await db.exec('ROLLBACK')
    expect(await one('SELECT count(*)::int n FROM face_match_requests')).toEqual({ n: 0 })
  })
})

it('preserves original assignments and scores for a full 100-face batch', async () => {
  const original = readFileSync(
    'migrations/postgres/202610211200_people_rematch_unnamed.sql',
    'utf8',
  )
  const functionSql = original.slice(
    original.indexOf('CREATE OR REPLACE FUNCTION'),
    original.indexOf('END $$;') + 'END $$;'.length,
  )
  await db.exec(
    functionSql.replace('face_worker.match_candidates(', 'face_worker.baseline_match_candidates('),
  )
  await seedReferences()
  await db.exec(
    `INSERT INTO face_people(person_id,owner_username,name) VALUES('${DANA}','ALICE','Dana')`,
  )
  for (const photo of [5, 6, 7]) {
    await publish(photo, [face(0, [0, 1, 0])])
    await db.query(
      `INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES($1,'${DANA}','ALICE','confirmed')`,
      [await faceId(photo)],
    )
  }
  // Deterministic vectors span strong, ambiguous, weak and rejected candidates.
  await db.query(`INSERT INTO faces(photo_id,owner_username,source,source_path,model_version,face_index,box_x,box_y,box_w,box_h,embedding,quality_ok,detection_score,quality)
    SELECT 8,'ALICE','detected','originals/8.jpg','sface-2021dec',g,0,0,0.1,0.1,
      ARRAY[cos(g*0.03),sin(g*0.03),0]::vector,true,0.99,0.9 FROM generate_series(0,99) g`)
  const ids = (
    await db.query<{ face_id: number }>(
      'SELECT face_id FROM faces WHERE photo_id=8 ORDER BY face_id',
    )
  ).rows.map((r) => r.face_id)
  await db.query(
    `INSERT INTO face_rejections(face_id,person_id,owner_username) VALUES($1,'${KEITH}','ALICE')`,
    [ids[0]],
  )
  async function evaluate(fn: string) {
    await db.exec('SAVEPOINT comparison')
    const count = await one(
      `SELECT face_worker.${fn}('ALICE','sface-2021dec',0.8,0.6,$1::bigint[]) AS changed`,
      [ids],
    )
    const rows = (
      await db.query(
        'SELECT face_id,person_id,status,score FROM face_assignments WHERE face_id=ANY($1::bigint[]) ORDER BY face_id',
        [ids],
      )
    ).rows
    await db.exec('ROLLBACK TO SAVEPOINT comparison; RELEASE SAVEPOINT comparison')
    return { count, rows }
  }
  await db.exec('BEGIN; SET LOCAL ROLE personal_photos_face_worker')
  try {
    const expected = await evaluate('baseline_match_candidates')
    const actual = await evaluate('match_candidates')
    expect(actual).toEqual(expected)
    expect(actual.rows.length).toBeGreaterThan(0)
  } finally {
    await db.exec('ROLLBACK')
  }
})
