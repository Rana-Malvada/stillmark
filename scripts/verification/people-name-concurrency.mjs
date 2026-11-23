/** Real PostgreSQL owner/name races using the application correction code.
 * Synthetic local database only; no production credentials or network services. */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { build } from 'esbuild'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { withLocalPostgres } from './local-postgres.mjs'

const bridge = `people-name-${randomUUID()}`
const bundled = await build({
  stdin: {
    contents:
      "export {assignToPerson,renamePerson,movePersonFaces,undo,updateSettings,getSettings} from './lib/people'",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'local-postgres',
      setup(b) {
        b.onResolve({ filter: /(?:^|\/)postgres$/ }, () => ({
          path: 'postgres',
          namespace: 'local',
        }))
        b.onLoad({ filter: /.*/, namespace: 'local' }, () => ({
          contents: `const b=globalThis['${bridge}'];export const pgQuery=(...a)=>b.query(...a);export const pgQueryOne=async(...a)=>(await b.query(...a))[0]??null;export const pgTransaction=(f)=>b.transaction(f);`,
        }))
      },
    },
  ],
})
await withLocalPostgres('people-name-concurrency', async ({ admin, connect, imageId }) => {
  const session = new AsyncLocalStorage()
  const owner = new AsyncLocalStorage()
  const transaction = async (fn) => {
    if (session.getStore()) return fn()
    const client = await connect()
    try {
      await client.query('BEGIN; SET LOCAL ROLE personal_photos_app')
      await client.query("SELECT set_config('photos.username',$1,true)", [owner.getStore()])
      const result = await session.run(client, fn)
      await client.query('COMMIT')
      return result
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      await client.end()
    }
  }
  globalThis[bridge] = {
    transaction,
    query: (sql, params) =>
      transaction(async () => (await session.getStore().query(sql, params)).rows),
  }
  const people = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
  )
  const as = (who, fn) => owner.run(who, fn)
  await admin.query(`CREATE ROLE personal_photos_app; CREATE SCHEMA photo_security;
  CREATE FUNCTION photo_security.username() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('photos.username',true) $$;
  CREATE TABLE face_settings(owner_username text PRIMARY KEY,enabled bool NOT NULL,share_names bool NOT NULL,updated_at timestamptz DEFAULT now());
  CREATE TABLE face_people(person_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_username text NOT NULL,name text,hidden bool DEFAULT false,cover_face_id bigint,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
  CREATE TABLE faces(face_id bigint PRIMARY KEY,photo_id bigint,owner_username text NOT NULL,ignored bool DEFAULT false,crop_path text,quality float);
  CREATE TABLE face_assignments(face_id bigint PRIMARY KEY,person_id uuid,owner_username text NOT NULL,status text,score float);
  CREATE TABLE face_rejections(face_id bigint,person_id uuid,owner_username text NOT NULL,created_at timestamptz DEFAULT now(),PRIMARY KEY(face_id,person_id));
  CREATE TABLE face_corrections(id bigserial PRIMARY KEY,owner_username text NOT NULL,kind text,summary text,before_state jsonb,created_by text,created_at timestamptz DEFAULT now(),undone_at timestamptz);
  GRANT USAGE ON SCHEMA public,photo_security TO personal_photos_app;
  GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO personal_photos_app;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO personal_photos_app;`)
  for (const table of [
    'face_settings',
    'face_people',
    'faces',
    'face_assignments',
    'face_rejections',
    'face_corrections',
  ]) {
    await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    CREATE POLICY own ON ${table} TO personal_photos_app USING(owner_username=photo_security.username()) WITH CHECK(owner_username=photo_security.username());`)
  }
  await admin.query(
    `INSERT INTO faces(face_id,photo_id,owner_username,quality) SELECT i,i,CASE WHEN i=99 THEN 'BOB' ELSE 'ALICE' END,1 FROM unnest(ARRAY[1,2,3,4,5,6,7,8,99])i`,
  )
  const blocker = await connect()
  await blocker.query(
    "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('people-corrections:ALICE',0))",
  )
  let settled = 0
  const first = as('ALICE', () =>
    people.assignToPerson({ faceIds: [1], name: 'Same name' }),
  ).finally(() => settled++)
  const second = as('ALICE', () =>
    people.assignToPerson({ faceIds: [2], name: 'SAME NAME' }),
  ).finally(() => settled++)
  await delay(100)
  assert.equal(settled, 0, 'Both corrections must wait before inspecting names')
  const bob = await as('BOB', () => people.assignToPerson({ faceIds: [99], name: 'Same name' }))
  await blocker.query('COMMIT')
  await blocker.end()
  const assigned = await Promise.all([first, second])
  assert.equal(assigned[0].personId, assigned[1].personId)
  assert.notEqual(bob.personId, assigned[0].personId)
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int n FROM face_people WHERE owner_username='ALICE' AND lower(name)='same name'",
      )
    ).rows[0].n,
    1,
  )
  // Latest undo is serialized with names and affects only its own captured face.
  const latest = assigned.toSorted((a, b) => b.correctionId - a.correctionId)[0]
  await as('ALICE', () => people.undo(latest.correctionId))
  assert.equal(
    (await admin.query('SELECT count(*)::int n FROM face_assignments WHERE face_id IN(1,2)'))
      .rows[0].n,
    1,
  )
  const renamed = await as('ALICE', () =>
    people.assignToPerson({ faceIds: [3], name: 'Before rename' }),
  )
  const raced = await Promise.allSettled([
    as('ALICE', () => people.renamePerson(renamed.personId, 'Race name')),
    as('ALICE', () => people.assignToPerson({ faceIds: [4], name: 'RACE NAME' })),
  ])
  assert.equal(raced[1].status, 'fulfilled')
  if (raced[0].status === 'rejected') assert.equal(raced[0].reason.status, 409)
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int n FROM face_people WHERE owner_username='ALICE' AND lower(name)='race name'",
      )
    ).rows[0].n,
    1,
  )
  const source = await as('ALICE', () => people.assignToPerson({ faceIds: [5, 6], name: 'Source' }))
  const moves = await Promise.all([
    as('ALICE', () => people.movePersonFaces(source.personId, [5], 'Moved name')),
    as('ALICE', () => people.movePersonFaces(source.personId, [6], 'MOVED NAME')),
  ])
  assert.equal(moves[0].personId, moves[1].personId)
  assert.equal(
    (await admin.query("SELECT count(*)::int n FROM face_people WHERE lower(name)='moved name'"))
      .rows[0].n,
    1,
  )
  await assert.rejects(
    as('BOB', () => people.movePersonFaces(source.personId, [5], 'Not mine')),
    (e) => e.status === 404,
  )
  await admin.query(
    "INSERT INTO face_people(owner_username,name) VALUES('ALICE','Ambiguous'),('ALICE','AMBIGUOUS')",
  )
  await assert.rejects(
    as('ALICE', () => people.assignToPerson({ faceIds: [7], name: 'ambiguous' })),
    (e) => e.status === 409,
  )
  // Independent PATCH fields must survive concurrent first inserts and later updates.
  for (const existing of [false, true]) {
    if (existing)
      await as('ALICE', () => people.updateSettings({ enabled: false, shareNames: true }))
    const held = await connect()
    await held.query(
      "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('people-corrections:ALICE',0))",
    )
    let finished = 0
    const updates = [
      as('ALICE', () => people.updateSettings({ enabled: true })).finally(() => finished++),
      as('ALICE', () => people.updateSettings({ shareNames: false })).finally(() => finished++),
    ]
    await delay(100)
    assert.equal(finished, 0, 'Settings must wait before reading the previous privacy flags')
    await as('BOB', () => people.updateSettings({ enabled: true }))
    await held.query('COMMIT')
    await held.end()
    await Promise.all(updates)
    assert.deepEqual(await as('ALICE', () => people.getSettings()), {
      enabled: true,
      shareNames: false,
    })
  }
  console.log(
    JSON.stringify({
      imageId,
      settings: 'concurrent privacy PATCH preserved',
      sameNameCreate: 'one identity',
      renameCreate: 'no duplicate',
      parallelMove: 'one identity',
      undo: 'preserved',
      owners: 'independent and isolated',
      ambiguous: 'rejected',
    }),
  )
  delete globalThis[bridge]
})
