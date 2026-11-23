/** Disposable PostgreSQL checks for resumable face-group merging. No production access. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withLocalPostgres } from './local-postgres.mjs'

const source = (name) =>
  readFileSync(new URL('../../migrations/postgres/' + name + '.sql', import.meta.url), 'utf8')
await withLocalPostgres(
  'bounded-face-merge',
  async ({ admin: db, connect }) => {
    await db.query(`CREATE EXTENSION vector; CREATE SCHEMA face_worker; CREATE SCHEMA photo_security;
    CREATE ROLE personal_photos_face_worker; CREATE ROLE personal_photos_app;
    GRANT USAGE ON SCHEMA face_worker,public TO personal_photos_face_worker;`)
    const base = source('202610072000_people_faces')
    await db.query(
      base
        .slice(
          base.indexOf('CREATE TABLE public.face_people ('),
          base.indexOf('CREATE TABLE public.face_corrections ('),
        )
        .replace(/CREATE INDEX face_people_name_trgm[^;]+;/, ''),
    )
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.face_people,public.faces,public.face_assignments TO personal_photos_face_worker;
    GRANT SELECT ON public.face_rejections TO personal_photos_face_worker;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO personal_photos_face_worker;
    ALTER TABLE public.face_people ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.faces ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.face_assignments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.face_rejections ENABLE ROW LEVEL SECURITY;
    CREATE POLICY worker ON public.face_people TO personal_photos_face_worker USING(true) WITH CHECK(true);
    CREATE POLICY worker ON public.faces TO personal_photos_face_worker USING(true) WITH CHECK(true);
    CREATE POLICY worker ON public.face_assignments TO personal_photos_face_worker USING(true) WITH CHECK(true);
    CREATE POLICY worker ON public.face_rejections FOR SELECT TO personal_photos_face_worker USING(true);`)
    for (const name of [
      '202610072200_people_merge_unnamed',
      '202610081100_people_stable_covers',
      '202611212330_bounded_unnamed_merge',
    ])
      await db.query(source(name))
    // Exercise the actual worker lineage query with real run/queue definitions.
    await db.query(
      base.slice(
        base.indexOf('CREATE TABLE public.face_scan_runs ('),
        base.indexOf('-- Corrections take priority'),
      ),
    )
    const recovery = source('202611220100_worker_cycle_recovery')
    await db.query(
      recovery.slice(
        recovery.indexOf('ALTER TABLE public.face_scan_runs'),
        recovery.indexOf('ALTER TABLE public.video_preparation_runs'),
      ),
    )
    const queueFunctions = source('202610072010_people_worker_queue')
    await db.query(
      queueFunctions.slice(
        queueFunctions.indexOf('CREATE FUNCTION face_worker.run_owners'),
        queueFunctions.indexOf('REVOKE ALL ON ALL FUNCTIONS'),
      ),
    )
    await db.query(`GRANT SELECT ON public.face_scan_runs,public.face_scan_queue TO personal_photos_face_worker;
    REVOKE ALL ON FUNCTION face_worker.run_owners(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION face_worker.run_owners(uuid) TO personal_photos_face_worker;`)
    const worker = await connect('personal_photos_face_worker')
    const app = await connect('personal_photos_app')
    const id = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0')
    await db.query(
      `INSERT INTO public.face_scan_runs(id,requested_by,kind,status,photo_limit,continued_from)
      VALUES ($1,'actor','incremental','completed',100,NULL),($2,'actor','incremental','completed',100,$1),($3,'actor','incremental','starting',100,$2);
      `,
      [id(9001), id(9002), id(9003)],
    )
    await db.query(
      `INSERT INTO public.face_scan_queue(photo_id,owner_username,source_path,run_id)
      VALUES (9001,'first-owner','one',$1),(9002,'second-owner','two',$2),(9003,'first-owner','three',$2)`,
      [id(9001), id(9002)],
    )
    const lineageOwners = await worker.query(
      `WITH RECURSIVE lineage AS (
      SELECT id,continued_from FROM public.face_scan_runs WHERE id=$1
      UNION ALL SELECT r.id,r.continued_from FROM public.face_scan_runs r JOIN lineage l ON r.id=l.continued_from
    ) SELECT DISTINCT owner FROM lineage l CROSS JOIN LATERAL face_worker.run_owners(l.id) owner ORDER BY owner`,
      [id(9003)],
    )
    assert.deepEqual(
      lineageOwners.rows.map((r) => r.owner),
      ['first-owner', 'second-owner'],
      'organization-only successor retains ancestor owners',
    )
    await db.query(`INSERT INTO public.face_people(person_id,owner_username)
    SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'owner' FROM generate_series(1,503) n;
    INSERT INTO public.faces(photo_id,owner_username,source_path,model_version,face_index,box_x,box_y,box_w,box_h,detection_score,quality,quality_ok,embedding,crop_path)
    SELECT n,'owner','p/'||n,'model',0,0,0,1,1,1,1,true,'[1,0]'::vector,'crop/'||n FROM generate_series(1,5503) n;
    INSERT INTO public.face_assignments(face_id,person_id,owner_username,status)
    SELECT n,('00000000-0000-0000-0000-'||lpad((CASE WHEN n>503 THEN 1 ELSE n END)::text,12,'0'))::uuid,'owner','auto' FROM generate_series(1,5503) n;`)
    const state = async () =>
      (await worker.query("SELECT * FROM face_worker.merge_state('owner','model',0.8)")).rows[0]
    let s = await state()
    assert.equal(s.complete, false)
    assert.equal((await state()).generation, s.generation, 'reading does not invalidate the pass')
    let cursor = 0
    let total = 0
    for (;;) {
      const rows = (
        await worker.query(
          "SELECT * FROM face_worker.merge_face_page('owner','model',$1,$2,100000)",
          [id(1), cursor],
        )
      ).rows
      assert.ok(rows.length <= 512)
      if (!rows.length) break
      total += rows.length
      cursor = rows.at(-1).face_id
    }
    assert.equal(total, 5001)
    const lastPairs = (
      await worker.query("SELECT * FROM face_worker.merge_next_pair('owner','model',$1,$2)", [
        id(501),
        id(503),
      ])
    ).rows
    assert.equal(lastPairs.length, 1)
    assert.equal(lastPairs[0].left_id, id(502))
    assert.equal(lastPairs[0].right_id, id(503))
    // Both pair ranking and its generation are durable across connections/restarts.
    await worker.query("SELECT face_worker.merge_checkpoint('owner','model',$1,$2,$3,0.85)", [
      s.generation,
      id(1),
      id(2),
    ])
    await worker.query("SELECT face_worker.merge_checkpoint('owner','model',$1,$2,$3,0.95)", [
      s.generation,
      id(502),
      id(503),
    ])
    const restarted = await connect('personal_photos_face_worker')
    assert.equal(
      (await restarted.query("SELECT best_left FROM face_worker.merge_state('owner','model',0.8)"))
        .rows[0].best_left,
      id(502),
    )
    assert.equal(
      (
        await worker.query("SELECT face_worker.merge_finish_pass('owner','model',$1) AS n", [
          s.generation,
        ])
      ).rows[0].n,
      1,
    )
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM public.face_people')).rows[0].n,
      502,
    )
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM public.face_assignments WHERE person_id=$1',
          [id(502)],
        )
      ).rows[0].n,
      2,
    )
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM public.face_assignments WHERE person_id=$1',
          [id(1)],
        )
      ).rows[0].n,
      5001,
    )
    s = await state()
    // Every curation surface invalidates the checkpoint and excluded groups cannot merge.
    await db.query("UPDATE public.face_people SET name='Curated' WHERE person_id=$1", [id(2)])
    assert.equal(
      (
        await worker.query(
          "SELECT face_worker.merge_checkpoint('owner','model',$1,$2,$3,1) AS ok",
          [s.generation, id(2), id(3)],
        )
      ).rows[0].ok,
      false,
    )
    await db.query('UPDATE public.face_people SET hidden=true WHERE person_id=$1', [id(3)])
    await db.query("UPDATE public.face_assignments SET status='confirmed' WHERE person_id=$1", [
      id(4),
    ])
    await db.query(
      "INSERT INTO public.face_rejections(face_id,person_id,owner_username) VALUES(7,$1,'owner')",
      [id(5)],
    )
    await db.query('UPDATE public.faces SET ignored=true WHERE face_id=6')
    const earlyPairs = (
      await worker.query("SELECT * FROM face_worker.merge_next_pair('owner','model',NULL,NULL)")
    ).rows
    assert.equal(earlyPairs.length, 64)
    assert.ok(
      earlyPairs.every(
        (p) => ![2, 3, 4, 5, 6].some((n) => p.left_id === id(n) || p.right_id === id(n)),
      ),
    )
    for (const n of [2, 3, 4, 5, 6])
      assert.equal(
        (
          await worker.query(
            "SELECT * FROM face_worker.merge_face_page('owner','model',$1,0,512)",
            [id(n)],
          )
        ).rows.length,
        0,
      )
    const beforeRollback = (await state()).generation
    await db.query('BEGIN; UPDATE public.faces SET quality=0.5 WHERE face_id=8; ROLLBACK')
    assert.equal((await state()).generation, beforeRollback)
    // A pass without a candidate stays complete until new work actually commits.
    s = await state()
    assert.equal(
      (
        await worker.query("SELECT face_worker.merge_finish_pass('owner','model',$1) AS n", [
          s.generation,
        ])
      ).rows[0].n,
      0,
    )
    assert.equal((await state()).complete, true)
    await db.query('UPDATE public.faces SET quality=0.5 WHERE face_id=8')
    assert.equal((await state()).complete, false)
    await assert.rejects(app.query('SELECT * FROM face_worker.merge_progress'), /permission denied/)
    await assert.rejects(
      app.query("SELECT * FROM face_worker.merge_state('owner','model',0.8)"),
      /permission denied/,
    )
    await assert.rejects(
      worker.query("SELECT face_worker.merge_unnamed('owner',$1,$2::uuid[])", [
        id(1),
        Array(501).fill(id(7)),
      ]),
      /invalid merge/,
    )
    console.log(
      'PASS PostgreSQL bounded face merge: 5,001-face group, 503 groups, durable best pair, curated exclusions, invalidation, rollback and worker-only access',
    )
  },
  { vector: true },
)
