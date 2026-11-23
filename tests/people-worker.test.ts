import { createRouteDatabase } from './fixtures/route-database'
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
      '202611041200_dense_face_publication',
      '202610072200_people_merge_unnamed',
      '202610081100_people_stable_covers',
      '202610201400_people_candidate_matching',
    ],
  })
}, 60000)
afterAll(async () => db?.close())

beforeEach(async () => {
  await db.exec(`TRUNCATE face_assignments,face_rejections,face_corrections,face_scan_queue,stage_cleanup;
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
const claim = (batch: number) =>
  worker(
    async () =>
      (
        await db.query<{ photo_id: number; claim_token: string; source_path: string }>(
          'SELECT * FROM face_worker.claim($1,$2)',
          [RUN, batch],
        )
      ).rows,
  )
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

describe('claims and leases', () => {
  it('claims each due photo once, in order, with a lease', async () => {
    const first = await claim(3)
    const second = await claim(3)
    expect(first.map((r) => r.photo_id).sort()).toEqual([1, 2, 3])
    expect(second.map((r) => r.photo_id).sort()).toEqual([4, 5, 6])
    expect(
      await one(
        "SELECT count(*)::int n FROM face_scan_queue WHERE status='running' AND lease_until>now()",
      ),
    ).toEqual({ n: 6 })
  })
  it('recovers expired leases and fails after three attempts', async () => {
    await claim(1)
    await db.exec(
      `UPDATE face_scan_queue SET lease_until=now()-interval '1 second',attempts=3 WHERE photo_id=1`,
    )
    await claim(1)
    expect(await one('SELECT status,error FROM face_scan_queue WHERE photo_id=1')).toEqual({
      status: 'failed',
      error: 'Lease expired after maximum attempts',
    })
  })
  it('backs off on failure and counts terminal failures on the run', async () => {
    const [row] = await claim(1)
    expect(
      await worker(() =>
        one('SELECT face_worker.fail($1,$2,$3) ok', [1, row.claim_token, 'decode error']),
      ),
    ).toEqual({ ok: true })
    expect(
      await one(
        'SELECT status,error,next_attempt_at>now() later FROM face_scan_queue WHERE photo_id=1',
      ),
    ).toEqual({
      status: 'queued',
      error: 'decode error',
      later: true,
    })
    await db.exec(`UPDATE face_scan_queue SET next_attempt_at=now() WHERE photo_id=1`)
    for (let attempt = 2; attempt <= 3; attempt++) {
      const [retry] = await claim(1)
      expect(retry.photo_id).toBe(1)
      await worker(() =>
        one('SELECT face_worker.fail($1,$2,$3)', [1, retry.claim_token, 'decode error']),
      )
      await db.exec(`UPDATE face_scan_queue SET next_attempt_at=now() WHERE photo_id=1`)
    }
    expect(await one('SELECT status,attempts FROM face_scan_queue WHERE photo_id=1')).toEqual({
      status: 'failed',
      attempts: 3,
    })
    expect(await one(`SELECT failed FROM face_scan_runs WHERE id='${RUN}'`)).toEqual({ failed: 1 })
  })
  it('rejects a stale claim token', async () => {
    const [row] = await claim(1)
    await db.exec(`UPDATE face_scan_queue SET claim_token=gen_random_uuid() WHERE photo_id=1`)
    await expect(
      worker(() =>
        one('SELECT face_worker.publish($1,$2,$3,$4,$5)', [
          1,
          row.claim_token,
          'm',
          row.source_path,
          '[]',
        ]),
      ),
    ).rejects.toThrow(/stale face claim/)
    expect(await worker(() => one('SELECT face_worker.renew($1) n', [[row.claim_token]]))).toEqual({
      n: 0,
    })
  })
  it('refuses to publish when the original changed after the claim', async () => {
    const [row] = await claim(1)
    await db.exec(`UPDATE face_scan_queue SET source_path='originals/1.jpg' WHERE photo_id=1`)
    await db.exec(`ALTER TABLE photos DISABLE TRIGGER enqueue_face_scan;
      UPDATE photos SET original_stage_path='originals/1-new.jpg' WHERE photo_id=1;
      ALTER TABLE photos ENABLE TRIGGER enqueue_face_scan;`)
    await expect(
      worker(() =>
        one('SELECT face_worker.publish($1,$2,$3,$4,$5)', [
          1,
          row.claim_token,
          'm',
          row.source_path,
          '[]',
        ]),
      ),
    ).rejects.toThrow(/original changed/)
  })
})

describe('publication', () => {
  it('stores faces, completes the item and updates run progress', async () => {
    expect(await publish(1, [face(0, [1, 0, 0]), face(1, [0, 1, 0])])).toEqual({ n: 2 })
    expect(await one('SELECT status,model_version FROM face_scan_queue WHERE photo_id=1')).toEqual({
      status: 'done',
      model_version: 'sface-2021dec',
    })
    expect(await one(`SELECT processed,faces_found FROM face_scan_runs WHERE id='${RUN}'`)).toEqual(
      {
        processed: 1,
        faces_found: 2,
      },
    )
  })
  it('replaces earlier scanner output but keeps confirmed faces and manual tags', async () => {
    await publish(1, [face(0, [1, 0, 0]), face(1, [0, 1, 0])])
    await db.exec(
      `INSERT INTO face_people(person_id,owner_username,name) VALUES('${DANA}','ALICE','Dana')`,
    )
    const confirmed = await faceId(1, 0)
    await db.query(
      `INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES($1,'${DANA}','ALICE','confirmed')`,
      [confirmed],
    )
    await db.exec(
      `INSERT INTO faces(photo_id,owner_username,source,created_by) VALUES(1,'ALICE','manual','ALICE')`,
    )
    await publish(1, [face(0, [1, 0.01, 0]), face(1, [0, 0, 1])])
    const faces = (
      await db.query<{ face_id: number; source: string }>(
        'SELECT face_id,source FROM faces WHERE photo_id=1 ORDER BY face_id',
      )
    ).rows
    expect(faces).toHaveLength(3)
    expect(faces[0].face_id).toBe(confirmed)
    expect(faces.filter((f) => f.source === 'manual')).toHaveLength(1)
    // The re-detected confirmed region is not duplicated; its unused crop is cleaned up.
    expect((await db.query(`SELECT path FROM stage_cleanup ORDER BY path`)).rows).toEqual([
      { path: 'faces/x/0-1_0.01_0.webp' },
      { path: 'faces/x/1-0_1_0.webp' },
    ])
  })
  it('rejects malformed payloads', async () => {
    await expect(publish(1, [face(0, [1, 0, 0], { w: 0 })])).rejects.toThrow(/check constraint/)
  })
})

describe('matching', () => {
  async function seedNamedPeople() {
    await publish(1, [face(0, [1, 0, 0]), face(1, [0, 1, 0])])
    await db.exec(
      `INSERT INTO face_people(person_id,owner_username,name) VALUES('${DANA}','ALICE','Dana'),('${KEITH}','ALICE','Keith')`,
    )
    await db.query(
      `INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES($1,'${DANA}','ALICE','confirmed'),($2,'${KEITH}','ALICE','confirmed')`,
      [await faceId(1, 0), await faceId(1, 1)],
    )
  }
  it('auto-assigns strong matches and suggests uncertain ones', async () => {
    await seedNamedPeople()
    await publish(2, [face(0, [0.98, 0.1, 0])])
    await publish(3, [face(0, [0.7, 0.3, 0.6])])
    await publish(4, [face(0, [0, 0, 1])])
    expect(await match()).toEqual({ n: 2 })
    expect(await assignment(await faceId(2))).toMatchObject({ person_id: DANA, status: 'auto' })
    expect(await assignment(await faceId(3))).toMatchObject({
      person_id: DANA,
      status: 'suggested',
    })
    expect(await assignment(await faceId(4))).toBeUndefined()
  })
  it('downgrades a strong but ambiguous match between two people to a suggestion', async () => {
    await seedNamedPeople()
    await publish(2, [face(0, [1, 0.95, 0])])
    await match('ALICE', 0.6, 0.5)
    expect(await assignment(await faceId(2))).toMatchObject({ status: 'suggested' })
  })
  it('never suggests a rejected person again', async () => {
    await seedNamedPeople()
    await publish(2, [face(0, [0.98, 0.1, 0])])
    const id = await faceId(2)
    await db.query(
      `INSERT INTO face_rejections(face_id,person_id,owner_username) VALUES($1,'${DANA}','ALICE')`,
      [id],
    )
    await match()
    expect(await assignment(id)).toBeUndefined()
  })
  it('uses only confirmed, good-quality references and skips ignored or hidden people', async () => {
    await seedNamedPeople()
    await db.exec(`UPDATE face_people SET hidden=true WHERE person_id='${KEITH}'`)
    await publish(2, [face(0, [0.02, 1, 0])])
    await publish(3, [face(0, [1, 0, 0], { quality_ok: false })])
    await match()
    expect(await assignment(await faceId(2))).toBeUndefined()
    expect(await assignment(await faceId(3))).toMatchObject({
      person_id: DANA,
      status: 'suggested',
    })
  })
  it('recognizes a lower-quality candidate against three confirmed references without promoting its quality', async () => {
    await seedNamedPeople()
    await publish(2, [face(0, [1, 0, 0])])
    await publish(3, [face(0, [1, 0, 0])])
    for (const photo of [2, 3])
      await db.query(
        `INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES($1,'${KEITH}','ALICE','confirmed')`,
        [await faceId(photo)],
      )
    // All three Keith references point in the same direction.
    await db.query('UPDATE faces SET embedding=$1 WHERE face_id=$2', [
      '[1,0,0]',
      await faceId(1, 1),
    ])
    await db.exec(`UPDATE face_people SET hidden=true WHERE person_id='${DANA}'`)
    await publish(4, [
      face(0, [0.8014, 0, Math.sqrt(1 - 0.8014 ** 2)], { score: 0.7979, quality_ok: false }),
    ])
    await match('ALICE', 0.6, 0.45)
    expect(await assignment(await faceId(4))).toMatchObject({ person_id: KEITH, status: 'auto' })
    expect(await one('SELECT quality_ok FROM faces WHERE photo_id=4')).toEqual({
      quality_ok: false,
    })
    expect(
      (
        await worker(() =>
          db.query("SELECT * FROM face_worker.unassigned('ALICE','sface-2021dec',100)"),
        )
      ).rows,
    ).toEqual([])
  })
  it('requires review for weaker lower-quality matches and never uses them as references', async () => {
    await seedNamedPeople()
    await publish(2, [face(0, [0.7, 0, Math.sqrt(0.51)], { quality_ok: false })])
    await publish(3, [face(0, [0.5, 0, Math.sqrt(0.75)], { quality_ok: false })])
    await match('ALICE', 0.6, 0.45)
    expect(await assignment(await faceId(2))).toMatchObject({
      person_id: DANA,
      status: 'suggested',
    })
    expect(await assignment(await faceId(3))).toBeUndefined()
    await db.exec(
      "UPDATE faces SET quality_ok=false WHERE photo_id=1; UPDATE face_assignments SET status='confirmed'",
    )
    await publish(4, [face(0, [0.7, 0, Math.sqrt(0.51)])])
    await match()
    expect(await assignment(await faceId(4))).toBeUndefined()
  })
  it('keeps ignored and rejected lower-quality detections out of matching', async () => {
    await seedNamedPeople()
    await publish(2, [face(0, [1, 0, 0], { quality_ok: false })])
    await publish(3, [face(0, [1, 0, 0], { quality_ok: false })])
    await db.exec('UPDATE faces SET ignored=true WHERE photo_id=2')
    await db.query(
      `INSERT INTO face_rejections(face_id,person_id,owner_username) VALUES($1,'${DANA}','ALICE')`,
      [await faceId(3)],
    )
    await match()
    expect(await assignment(await faceId(2))).toBeUndefined()
    expect(await assignment(await faceId(3))).toBeUndefined()
  })
  it('never matches across owners', async () => {
    await seedNamedPeople()
    await publish(9, [face(0, [1, 0, 0])])
    await match('BOB')
    await match('ALICE')
    expect(await assignment(await faceId(9))).toBeUndefined()
  })
  it('rejects invalid thresholds', async () => {
    await expect(match('ALICE', 0.5, 0.7)).rejects.toThrow(/invalid thresholds/)
  })
})

describe('unnamed groups', () => {
  it('creates a group from unassigned faces and picks the best-quality cover', async () => {
    await publish(1, [face(0, [1, 0, 0], { quality: 0.7 })])
    await publish(2, [face(0, [0.99, 0.05, 0], { quality: 0.95 })])
    const pending = (
      await worker(() =>
        db.query<{ face_id: number }>(
          "SELECT * FROM face_worker.unassigned('ALICE','sface-2021dec',100)",
        ),
      )
    ).rows
    expect(pending).toHaveLength(2)
    const ids = pending.map((r) => r.face_id)
    const { person } = await worker(() =>
      one<{ person: string }>('SELECT face_worker.create_group($1,$2,$3) person', [
        'ALICE',
        ids,
        [0.99, 0.99],
      ]),
    )
    expect(
      await one('SELECT name,cover_face_id FROM face_people WHERE person_id=$1', [person]),
    ).toEqual({
      name: null,
      cover_face_id: ids[1],
    })
    // Faces already grouped cannot form a second group.
    expect(
      await worker(() =>
        one('SELECT face_worker.create_group($1,$2,$3) person', ['ALICE', ids, [0.9, 0.9]]),
      ),
    ).toEqual({ person: null })
  })
  it('refuses to group faces from another owner', async () => {
    await publish(1, [face(0, [1, 0, 0])])
    await publish(9, [face(0, [1, 0, 0])])
    const members = [await faceId(1), await faceId(9)]
    await expect(
      worker(() => one('SELECT face_worker.create_group($1,$2,$3)', ['ALICE', members, [1, 1]])),
    ).rejects.toThrow(/outside owner scope/)
  })
  it('extends an unnamed group through matching', async () => {
    await publish(1, [face(0, [1, 0, 0])])
    await publish(2, [face(0, [0.99, 0.05, 0])])
    const members = [await faceId(1), await faceId(2)]
    const { person } = await worker(() =>
      one<{ person: string }>('SELECT face_worker.create_group($1,$2,$3) person', [
        'ALICE',
        members,
        [1, 1],
      ]),
    )
    await publish(3, [face(0, [0.98, 0.1, 0])])
    await match()
    expect(await assignment(await faceId(3))).toMatchObject({ person_id: person, status: 'auto' })
  })
})

describe('worker SQL as sent by psycopg', () => {
  // WHY THIS READS PYTHON SOURCE. The face worker is a Python program that talks to the
  // database through psycopg; it cannot run inside this test suite. The contract between
  // the two languages is the SQL text in the worker's string literals: the deployed
  // schema must accept exactly those statements, with parameters typed the way psycopg
  // types Python values (float -> float8, int list -> int8[], str -> untyped). Reading the
  // literals is the only way to test the statements the worker really sends. Nothing
  // below asserts on how the source is written: every statement taken from it is prepared
  // or run in PostgreSQL, and the assertions are on what the database does with it.
  const source = ['worker.py', 'bounded_merge.py']
    .map((name) => readFileSync('workers/face-cpu/' + name, 'utf8'))
    .join('\n')
  /** Every SQL string literal in the worker that calls a `face_worker` function. */
  const sent = [...source.matchAll(/"""([\s\S]*?)"""|"((?:[^"\\\n]|\\.)*)"/g)]
    .map((literal) => literal[1] ?? literal[2])
    .filter((sql) => /\bface_worker\.\w+\(/.test(sql))
  /** A psycopg statement as PostgreSQL receives it: `%s` placeholders become `$1`, `$2`… */
  const numbered = (sql: string) => {
    let n = 0
    return { sql: sql.replace(/%s/g, () => `$${++n}`), parameters: n }
  }
  const statement = (fn: string) => {
    const found = sent.find((sql) => sql.includes(`face_worker.${fn}(`))
    if (!found) throw new Error(`worker statement for ${fn} not found`)
    return numbered(found).sql
  }
  /** Plans a statement without running it, with every parameter declared as text. */
  const prepare = async (database: PGlite, sql: string, parameters: number) => {
    const types = parameters ? `(${Array(parameters).fill('text').join(',')})` : ''
    await database.exec(`PREPARE worker_statement${types} AS ${sql}`)
    await database.exec('DEALLOCATE worker_statement')
  }

  // The worker's statements use functions from every People migration, so they are checked
  // against the whole deployed schema, not the subset the rest of this file builds.
  let deployed: PGlite
  beforeAll(async () => {
    deployed = await createRouteDatabase()
  }, 60000)
  afterAll(async () => deployed?.close())

  it('sends only statements the deployed schema accepts, however the driver types their parameters', async () => {
    const called = new Set(
      sent.flatMap((sql) => [...sql.matchAll(/\bface_worker\.(\w+)\(/g)].map((call) => call[1])),
    )
    // A function missing here means the worker stopped calling it or the literals moved.
    expect([...called].sort()).toEqual([
      'claim',
      'create_group',
      'fail',
      'finish',
      'heartbeat',
      'match',
      'merge_checkpoint',
      'merge_face_page',
      'merge_finish_pass',
      'merge_next_pair',
      'merge_state',
      'publish',
      'renew',
      'reserve_crops',
      'run_owners',
      'unassigned',
    ])
    for (const literal of sent) {
      const { sql, parameters } = numbered(literal)
      // Planning proves the function exists with these arguments and that every column
      // the worker selects exists. Declaring each parameter as text proves that every
      // argument carries its own cast: an uncast argument would look for a function
      // taking text there, which does not exist, exactly as an uncast Python float
      // (float8) finds no function taking real.
      await expect(prepare(deployed, sql, parameters), sql).resolves.toBeUndefined()
    }
  })
  it('would refuse the same statements without their casts (guards the check above)', async () => {
    const { sql, parameters } = numbered(sent.find((s) => s.includes('face_worker.match('))!)
    const uncast = sql.replace(/(\$\d+)::[a-z0-9]+(\[\])?/g, '$1')
    expect(uncast).not.toBe(sql)
    await expect(prepare(deployed, uncast, parameters)).rejects.toThrow(/does not exist/)
    // And a statement naming a function the schema does not have is refused too.
    await expect(
      prepare(deployed, sql.replace('face_worker.match(', 'face_worker.no_such_function('), 4),
    ).rejects.toThrow(/does not exist/)
  })
  it('finds the owners of a run that continues an earlier run with no photos of its own', async () => {
    const NEXT = '77777777-7777-4777-8777-777777777777'
    const OTHER = '88888888-8888-4888-8888-888888888888'
    await deployed.exec(`INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username) VALUES(1,1,'Alice','a','ALICE'),(2,2,'Bob','b','BOB');
 INSERT INTO face_settings(owner_username,enabled) VALUES('ALICE',true),('BOB',true);
 INSERT INTO face_scan_runs(id,requested_by,kind,status,photo_limit) VALUES('${RUN}','ALICE','pilot','completed',100);
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path)
  SELECT g,CASE WHEN g<=8 THEN 1 ELSE 2 END,g||'.jpg','photo','READY','originals/'||g||'.jpg' FROM generate_series(1,10) g;
 UPDATE face_scan_queue SET run_id='${RUN}';
 INSERT INTO face_scan_runs(id,requested_by,kind,status,photo_limit,continued_from) VALUES('${NEXT}','ALICE','pilot','running',100,'${RUN}');
 INSERT INTO face_scan_runs(id,requested_by,kind,status,photo_limit) VALUES('${OTHER}','ALICE','pilot','completed',100);`)
    // The worker's own statement, run as the worker's database role. psycopg sends the run
    // identifier as an untyped string, which only the statement's ::uuid cast makes usable.
    const owners = async (run: string) => {
      await deployed.exec('BEGIN;SET LOCAL ROLE personal_photos_face_worker')
      try {
        const { rows } = await deployed.query<{ owner: string }>(statement('run_owners'), [run], {
          paramTypes: [TEXT],
        })
        return rows.map((row) => row.owner).sort()
      } finally {
        await deployed.exec('ROLLBACK')
      }
    }
    expect(await owners(RUN)).toEqual(['ALICE', 'BOB'])
    // The continuing run has no queued photos; its owners come from the run it continues.
    expect(
      await deployed.query('SELECT 1 FROM face_scan_queue WHERE run_id=$1', [NEXT]),
    ).toMatchObject({ rows: [] })
    expect(await owners(NEXT)).toEqual(['ALICE', 'BOB'])
    expect(await owners(OTHER)).toEqual([])
  })
  // Postgres type OIDs psycopg uses for Python values.
  const TEXT = 25
  const FLOAT8 = 701
  const INT2_ARRAY = 1005
  const INT8_ARRAY = 1016
  const FLOAT8_ARRAY = 1022
  it('matches and groups with float8 thresholds and small or large integer IDs', async () => {
    await publish(1, [face(0, [1, 0, 0])])
    await publish(2, [face(0, [0.99, 0.05, 0])])
    const ids = [await faceId(1), await faceId(2)]
    const group = (idType: number) =>
      worker(() =>
        one(`${statement('create_group')} AS p`, ['ALICE', ids, [0.99, 0.98]], {
          paramTypes: [TEXT, idType, FLOAT8_ARRAY],
        }),
      )
    expect((await group(INT8_ARRAY)).p).toMatch(/^[0-9a-f-]{36}$/)
    // Already grouped: resolves the same signature and returns NULL rather than failing.
    expect(await group(INT2_ARRAY)).toEqual({ p: null })
    await publish(3, [face(0, [0.98, 0.1, 0])])
    const matched = await worker(() =>
      db.query<{ n: number }>(
        `${statement('match')} AS n`,
        ['ALICE', 'sface-2021dec', 0.62, 0.45],
        {
          paramTypes: [TEXT, TEXT, FLOAT8, FLOAT8],
        },
      ),
    )
    expect(matched.rows[0]).toEqual({ n: 1 })
  })
  it('would fail without the casts (guards against regressions in the test itself)', async () => {
    await expect(
      worker(() =>
        db.query('SELECT face_worker.match($1,$2,$3,$4)', ['ALICE', 'm', 0.62, 0.45], {
          paramTypes: [TEXT, TEXT, FLOAT8, FLOAT8],
        }),
      ),
    ).rejects.toThrow(/does not exist/)
  })
})

describe('publication counts', () => {
  it('stores adjacent faces in one photo and counts only stored rows', async () => {
    const result = await publish(1, [
      face(0, [1, 0, 0], { x: 0.1, w: 0.12 }),
      face(1, [0, 1, 0], { x: 0.2, w: 0.12 }),
    ])
    expect(result).toEqual({ n: 2 })
    expect(await one('SELECT count(*)::int n FROM faces WHERE photo_id=1')).toEqual({ n: 2 })
    expect(await one(`SELECT faces_found FROM face_scan_runs WHERE id='${RUN}'`)).toEqual({
      faces_found: 2,
    })
    expect(await one(`SELECT count(*)::int n FROM stage_cleanup`)).toEqual({ n: 0 })
  })
})

describe('merging unnamed groups', () => {
  async function grouped(photos: number[], vector: number[]) {
    for (const p of photos) await publish(p, [face(0, vector)])
    const ids: number[] = []
    for (const p of photos) ids.push(await faceId(p))
    return (
      await worker(() =>
        one<{ p: string }>('SELECT face_worker.create_group($1,$2,$3) p', [
          'ALICE',
          ids,
          ids.map(() => 0.9),
        ]),
      )
    ).p
  }
  const merge = (keep: string, absorb: string[]) =>
    worker(() =>
      one<{ n: number }>('SELECT face_worker.merge_unnamed($1,$2,$3) n', ['ALICE', keep, absorb]),
    )
  const members = async (person: string) =>
    (
      await one<{ n: number }>('SELECT count(*)::int n FROM face_assignments WHERE person_id=$1', [
        person,
      ])
    ).n

  it('moves faces into the kept group, removes the empty group and picks a cover', async () => {
    const a = await grouped([1, 2], [1, 0, 0])
    const b = await grouped([3, 4], [0.9, 0.1, 0])
    expect(await merge(a, [b])).toEqual({ n: 1 })
    expect(await members(a)).toBe(4)
    expect(await one('SELECT count(*)::int n FROM face_people WHERE person_id=$1', [b])).toEqual({
      n: 0,
    })
    expect(
      (await one<{ c: number }>('SELECT cover_face_id c FROM face_people WHERE person_id=$1', [a]))
        .c,
    ).not.toBeNull()
  })
  it('keeps the existing cover when higher-quality faces join the group', async () => {
    const a = await grouped([1, 2], [1, 0, 0])
    const b = await grouped([3, 4], [1, 0, 0])
    const cover = await faceId(2)
    await db.query('UPDATE face_people SET cover_face_id=$1 WHERE person_id=$2', [cover, a])
    await db.query('UPDATE faces SET quality=0.99 WHERE photo_id IN (3,4)')
    expect(await merge(a, [b])).toEqual({ n: 1 })
    expect(await one('SELECT cover_face_id FROM face_people WHERE person_id=$1', [a])).toEqual({
      cover_face_id: cover,
    })
  })
  it('replaces an unusable cover when groups merge', async () => {
    const a = await grouped([1, 2], [1, 0, 0])
    const b = await grouped([3, 4], [1, 0, 0])
    await db.query('UPDATE face_people SET cover_face_id=NULL WHERE person_id=$1', [a])
    await merge(a, [b])
    expect(
      (await one('SELECT cover_face_id FROM face_people WHERE person_id=$1', [a])).cover_face_id,
    ).not.toBeNull()
  })
  it('never merges named people or groups the owner has confirmed', async () => {
    const a = await grouped([1, 2], [1, 0, 0])
    const named = await grouped([3, 4], [1, 0, 0])
    const curated = await grouped([5, 6], [1, 0, 0])
    await db.query(`UPDATE face_people SET name='Dana' WHERE person_id=$1`, [named])
    await db.query(`UPDATE face_assignments SET status='confirmed' WHERE face_id=$1`, [
      await faceId(5),
    ])
    expect(await merge(a, [named, curated])).toEqual({ n: 0 })
    expect(await merge(named, [a])).toEqual({ n: 0 })
    expect(await members(named)).toBe(2)
    expect(await members(curated)).toBe(2)
  })
  it('skips a group containing a face the owner rejected for the kept group', async () => {
    const a = await grouped([1, 2], [1, 0, 0])
    const b = await grouped([3, 4], [1, 0, 0])
    await db.query(
      'INSERT INTO face_rejections(face_id,person_id,owner_username) VALUES($1,$2,$3)',
      [await faceId(3), a, 'ALICE'],
    )
    expect(await merge(a, [b])).toEqual({ n: 0 })
    expect(await members(b)).toBe(2)
  })
  it('stays within one owner and rejects malformed merges', async () => {
    const a = await grouped([1, 2], [1, 0, 0])
    await publish(9, [face(0, [1, 0, 0])])
    await publish(10, [face(0, [1, 0, 0])])
    const bobIds = [await faceId(9), await faceId(10)]
    const { p: bob } = await worker(() =>
      one<{ p: string }>('SELECT face_worker.create_group($1,$2,$3) p', [
        'BOB',
        bobIds,
        [0.9, 0.9],
      ]),
    )
    expect(await merge(a, [bob])).toEqual({ n: 0 })
    expect(await members(bob)).toBe(2)
    await expect(merge(a, [a])).rejects.toThrow(/invalid merge/)
  })
  it('lets the scanner delete only empty unnamed groups', async () => {
    const a = await grouped([1, 2], [1, 0, 0])
    await expect(
      worker(() => db.query('DELETE FROM face_people WHERE person_id=$1', [a])),
    ).rejects.toThrow(/only empty unnamed groups/)
    await db.exec(`INSERT INTO face_people(owner_username,name) VALUES('ALICE','Keith')`)
    await expect(
      worker(() => db.query(`DELETE FROM face_people WHERE name='Keith'`)),
    ).rejects.toThrow(/only empty unnamed groups/)
  })
  it('lists only mergeable groups for the worker', async () => {
    const a = await grouped([1, 2], [1, 0, 0])
    const named = await grouped([3, 4], [1, 0, 0])
    await db.query(`UPDATE face_people SET name='Dana' WHERE person_id=$1`, [named])
    const rows = (
      await worker(() =>
        db.query<{ person_id: string }>(
          "SELECT DISTINCT person_id FROM face_worker.unnamed_groups('ALICE','sface-2021dec')",
        ),
      )
    ).rows
    expect(rows.map((r) => r.person_id)).toEqual([a])
  })
})

describe('run lifecycle', () => {
  it('heartbeats move a starting run to running, and finish closes it once', async () => {
    expect(await worker(() => one('SELECT face_worker.heartbeat($1) s', [RUN]))).toEqual({
      s: 'running',
    })
    await worker(() => one("SELECT face_worker.finish($1,'completed',NULL)", [RUN]))
    await worker(() => one("SELECT face_worker.finish($1,'attention','late')", [RUN]))
    expect(await one(`SELECT status,error FROM face_scan_runs WHERE id='${RUN}'`)).toEqual({
      status: 'completed',
      error: null,
    })
  })
  it('lists only the owners queued for the run', async () => {
    expect(
      (await worker(() => db.query('SELECT * FROM face_worker.run_owners($1) o ORDER BY 1', [RUN])))
        .rows,
    ).toEqual([{ o: 'ALICE' }, { o: 'BOB' }])
  })
})

describe('dense face publication and final counts', () => {
  it('publishes all 686 detections without truncating the photo', async () => {
    const detections = Array.from({ length: 686 }, (_, i) => face(i, [1, 0, 0], { x: 0.1, y: 0.1 }))
    expect(await publish(1, detections)).toEqual({ n: 686 })
    expect(await one('SELECT count(*)::int n FROM faces WHERE photo_id=1')).toEqual({ n: 686 })
  })
  it('rejects an oversized payload before writing faces', async () => {
    const detections = Array.from({ length: 5001 }, (_, i) => face(i, [1, 0, 0], { x: 0.1 }))
    await expect(publish(1, detections)).rejects.toThrow('exceeds 5000')
    expect(await one('SELECT count(*)::int n FROM faces')).toEqual({ n: 0 })
  })
  it('reports seven failed photos rather than 21 attempts', async () => {
    await db.exec(`UPDATE face_scan_runs SET status='running',failed=7 WHERE id='${RUN}'`)
    await worker(() =>
      db.query("SELECT face_worker.finish($1,'attention','21 photo(s) could not be scanned')", [
        RUN,
      ]),
    )
    expect(await one('SELECT error FROM face_scan_runs WHERE id=$1', [RUN])).toEqual({
      error: '7 photo(s) could not be scanned',
    })
  })
  it('finishes successfully when transient failures recovered', async () => {
    await db.exec(
      `UPDATE face_scan_runs SET status='running',failed=0 WHERE id='${RUN}'; UPDATE face_scan_queue SET status='done';`,
    )
    await worker(() =>
      db.query("SELECT face_worker.finish($1,'attention','2 photo(s) could not be scanned')", [
        RUN,
      ]),
    )
    expect(await one('SELECT status,error FROM face_scan_runs WHERE id=$1', [RUN])).toEqual({
      status: 'completed',
      error: null,
    })
  })
})
