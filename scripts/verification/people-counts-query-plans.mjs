import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withLocalPostgres } from './local-postgres.mjs'

await withLocalPostgres('people-count-benchmark', async ({ admin, imageId }) => {
  await admin.query(`CREATE ROLE personal_photos_app; CREATE SCHEMA photo_security;
 CREATE FUNCTION photo_security.username() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('app.username',true) $$;
 CREATE TABLE events(event_id int PRIMARY KEY,owner_username text);
 CREATE TABLE photos(photo_id int PRIMARY KEY,event_id int);
 CREATE TABLE face_people(person_id uuid PRIMARY KEY,owner_username text,name text,hidden boolean DEFAULT false);
 CREATE INDEX face_people_owner ON face_people(owner_username);
 CREATE TABLE faces(face_id bigint PRIMARY KEY,photo_id int,owner_username text,ignored boolean DEFAULT false,quality_ok boolean DEFAULT true,model_version text DEFAULT 'test');
 CREATE INDEX faces_owner_photo ON faces(owner_username,photo_id);
 CREATE INDEX faces_owner_model ON faces(owner_username,model_version);
 CREATE TABLE face_assignments(face_id bigint PRIMARY KEY,person_id uuid,owner_username text,status text);
 CREATE INDEX face_assignments_person ON face_assignments(person_id,status);
 INSERT INTO events VALUES(1,'alice'),(2,'bob');
 INSERT INTO photos SELECT i,CASE WHEN i<=100000 THEN 1 ELSE 2 END FROM generate_series(1,101000)i;
 INSERT INTO face_people(person_id,owner_username,name) SELECT md5(i::text)::uuid,CASE WHEN i<=5000 THEN 'alice' ELSE 'bob' END,'Person '||lpad((i/3)::text,6,'0') FROM generate_series(1,5050)i;
 INSERT INTO faces(face_id,photo_id,owner_username) SELECT i,(i+1)/2,CASE WHEN i<=200000 THEN 'alice' ELSE 'bob' END FROM generate_series(1,202000)i;
 INSERT INTO face_assignments SELECT face_id,md5((CASE WHEN face_id<=200000 THEN 1+((face_id-1)%5000) ELSE 5001+((face_id-200001)%50) END)::text)::uuid,owner_username,'confirmed' FROM faces;
 UPDATE faces SET ignored=true WHERE face_id%17=0;
 UPDATE face_assignments SET status='suggested' WHERE face_id%11=0;
 UPDATE faces SET owner_username='bob' WHERE face_id=199999;
 UPDATE face_assignments SET owner_username='bob' WHERE face_id=199998;
 UPDATE photos SET event_id=2 WHERE photo_id=99997;
 ANALYZE; SET app.username='alice';`)
  await admin.query(
    readFileSync(
      new URL('../../migrations/postgres/202611142300_people_counts.sql', import.meta.url),
      'utf8',
    ),
  )
  const query = `SELECT p.person_id,p.name,c.* FROM face_people p JOIN photo_security.person_counts(NULL) c USING(person_id)
 WHERE p.owner_username=photo_security.username() AND p.name IS NOT NULL AND NOT p.hidden
 ORDER BY lower(name),c.sort_count DESC,p.person_id LIMIT 201`
  const results = []
  for (let i = 0; i < 4; i++) {
    const plan = (await admin.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + query)).rows[0][
      'QUERY PLAN'
    ][0]
    results.push({
      executionMs: plan['Execution Time'],
      sharedHitBlocks: plan.Plan['Shared Hit Blocks'],
      sharedReadBlocks: plan.Plan['Shared Read Blocks'],
      rows: plan.Plan['Actual Rows'],
    })
  }
  const before = await snapshots()
  const aclBefore = (
    await admin.query(
      "SELECT proowner,proacl FROM pg_proc WHERE oid='photo_security.person_counts(uuid)'::regprocedure",
    )
  ).rows
  await admin.query(
    readFileSync(
      new URL(
        '../../migrations/postgres/202611212300_people_counts_query_plans.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  assert.deepEqual(
    await snapshots(),
    before,
    'Counts, selected-person scope and ordered page must be identical',
  )
  assert.deepEqual(
    (
      await admin.query(
        "SELECT proowner,proacl FROM pg_proc WHERE oid='photo_security.person_counts(uuid)'::regprocedure",
      )
    ).rows,
    aclBefore,
    'Function owner and execution grants must be retained',
  )
  const optimized = []
  for (let i = 0; i < 4; i++) {
    const plan = (await admin.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + query)).rows[0][
      'QUERY PLAN'
    ][0]
    optimized.push({
      executionMs: plan['Execution Time'],
      sharedHitBlocks: plan.Plan['Shared Hit Blocks'],
      rows: plan.Plan['Actual Rows'],
    })
  }
  async function snapshots() {
    const output = {}
    for (const owner of ['alice', 'bob', '', 'shared-viewer']) {
      await admin.query("SELECT set_config('app.username',$1,false)", [owner])
      const all = (
        await admin.query('SELECT * FROM photo_security.person_counts(NULL) ORDER BY person_id')
      ).rows
      output[owner] = all
      for (const id of ['1', '4999', '5001']) {
        const selected = (
          await admin.query('SELECT * FROM photo_security.person_counts(md5($1)::uuid)', [id])
        ).rows
        const target = (await admin.query('SELECT md5($1)::uuid AS id', [id])).rows[0].id
        assert.deepEqual(
          selected,
          all.filter((row) => row.person_id === target),
        )
      }
      if (!owner || owner === 'shared-viewer') assert.deepEqual(all, [])
    }
    await admin.query("SET app.username='alice'")
    output.orderedPage = (await admin.query(query)).rows
    await admin.query(
      'GRANT USAGE ON SCHEMA photo_security TO personal_photos_app; SET ROLE personal_photos_app',
    )
    output.appRole = (
      await admin.query('SELECT * FROM photo_security.person_counts(NULL) ORDER BY person_id')
    ).rows
    assert.deepEqual(output.appRole, output.alice)
    await admin.query('RESET ROLE')
    return output
  }
  console.log(
    JSON.stringify({
      postgres: (await admin.query('SHOW server_version')).rows[0].server_version,
      image: imageId,
      facesForOwner: 200000,
      peopleForOwner: 5000,
      before: results,
      after: optimized,
      checks: [
        'identical full and selected counts',
        'identical pagination order including name ties',
        'ignored and suggested faces',
        'mismatched face,assignment and album owners excluded',
        'no identity/shared viewer empty',
        'non-admin execution and unchanged owner/grants',
      ],
      productionChanges: 0,
    }),
  )
})
