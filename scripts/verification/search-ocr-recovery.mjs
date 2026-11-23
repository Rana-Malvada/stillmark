/** Exercise actual admission/maintenance SQL on isolated PostgreSQL, optionally
 * kill and recover the exact built worker image with real OCR/CLIP inference. */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { withLocalPostgres } from './local-postgres.mjs'

const bundled = await build({
  entryPoints: ['lib/search/search-batch.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'isolated-services',
      setup(builder) {
        builder.onResolve(
          {
            filter:
              /(^|\/)(postgres|database-context|search-batch-control|search-replay|search-sync)$/,
          },
          (args) => ({ path: args.path.split('/').at(-1), namespace: 'isolated' }),
        )
        builder.onLoad({ filter: /.*/, namespace: 'isolated' }, (args) => ({
          contents: {
            postgres: `const t=globalThis.__ocrRecoveryTest; export const pgQuery=t.query,pgQueryOne=async(...a)=>(await t.query(...a))[0],pgTransaction=t.transaction,withAdvisoryLock=t.lock;`,
            'database-context': `export const withServiceDatabase=fn=>fn();`,
            'search-batch-control': `export const searchBatchCommand=(...a)=>globalThis.__ocrRecoveryTest.command(...a);`,
            'search-replay': `export const refreshSavedSearches=async()=>{};`,
            'search-sync': `export const syncSearch=async()=>({remaining:0});`,
          }[args.path],
          loader: 'js',
        }))
      },
    },
  ],
})
await withLocalPostgres(
  'ocr-recovery',
  async ({ admin, connect, containerName, imageId }) => {
    await admin.query(`CREATE EXTENSION vector;
    CREATE ROLE personal_photos_app;CREATE ROLE personal_photos_maintenance;
    CREATE ROLE personal_photos_search_worker LOGIN;
    CREATE SCHEMA photo_security;CREATE FUNCTION photo_security.flag(text) RETURNS boolean LANGUAGE SQL AS 'SELECT false';
    CREATE TABLE photos(photo_id int PRIMARY KEY,original_stage_path text,ingest_status text DEFAULT 'READY',media_type text DEFAULT 'photo');
    CREATE TABLE face_scan_queue(photo_id int PRIMARY KEY,source_path text,status text);
    CREATE TABLE video_playback(photo_id int PRIMARY KEY,original_path text,status text);
    CREATE TABLE search_enrichment(photo_id int PRIMARY KEY,source_path text,status text,revision uuid DEFAULT gen_random_uuid(),claim_token uuid,lease_until timestamptz,attempts int DEFAULT 0,ocr_text text,ocr_confidence real,visual_embedding vector(512),model_version text,error text,updated_at timestamptz DEFAULT now());
    CREATE TABLE search_queue(kind text,id bigint,revision bigint DEFAULT 1,PRIMARY KEY(kind,id));
    CREATE TABLE search_sessions(id uuid,rerank_status text,expires_at timestamptz,scope_revision bigint,scope_ids int[],username text,claim_token uuid,lease_until timestamptz,attempts int DEFAULT 0);
    CREATE FUNCTION search_scope_revision(int[],text) RETURNS bigint LANGUAGE SQL AS 'SELECT 1::bigint';
    CREATE TABLE search_batch_runs(id uuid PRIMARY KEY,requested_by text,status text DEFAULT 'starting',photo_limit int,search_limit int,photos_done int DEFAULT 0,searches_done int DEFAULT 0,failures int DEFAULT 0,elapsed_ms bigint,created_at timestamptz DEFAULT clock_timestamp(),heartbeat_at timestamptz DEFAULT now(),finished_at timestamptz,error text,pipeline_error text,continued_by uuid REFERENCES search_batch_runs,settled_at timestamptz);
    CREATE UNIQUE INDEX one_search_batch ON search_batch_runs((true)) WHERE status IN ('starting','running');`)
    await admin.query(`CREATE TABLE lease_renewal_evidence(photo_id int,claim_token uuid,lease_until timestamptz);
    CREATE FUNCTION record_test_renewal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.claim_token=OLD.claim_token AND NEW.lease_until>OLD.lease_until THEN
        INSERT INTO lease_renewal_evidence VALUES(NEW.photo_id,NEW.claim_token,NEW.lease_until);
      END IF; RETURN NEW; END $$;
    CREATE TRIGGER record_test_renewal AFTER UPDATE ON search_enrichment FOR EACH ROW EXECUTE FUNCTION record_test_renewal();
    GRANT INSERT ON lease_renewal_evidence TO personal_photos_search_worker;`)
    await admin.query('BEGIN')
    await admin.query(
      readFileSync('migrations/postgres/202611212200_automatic_media_work.sql', 'utf8'),
    )
    await admin.query('COMMIT')
    await admin.query(
      'ALTER TABLE automatic_work_state ADD COLUMN retry_attempts int DEFAULT 0, ADD COLUMN next_attempt_at timestamptz DEFAULT now()',
    )
    await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO personal_photos_maintenance;
    GRANT SELECT,UPDATE ON search_enrichment,search_batch_runs,search_sessions TO personal_photos_search_worker;`)
    const context = new AsyncLocalStorage()
    const query = async (sql, values) =>
      (await (context.getStore() ?? admin).query(sql, values)).rows
    const launches = []
    let workerState = 'PENDING'
    globalThis.__ocrRecoveryTest = {
      query,
      transaction: async (fn) => {
        const db = context.getStore()
        await db.query('BEGIN')
        try {
          const value = await fn()
          await db.query('COMMIT')
          return value
        } catch (e) {
          await db.query('ROLLBACK')
          throw e
        }
      },
      lock: async (key, fn) => {
        const db = await connect('personal_photos_maintenance')
        try {
          if (
            !(
              await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [key])
            ).rows[0].locked
          )
            return null
          return await context.run(db, fn)
        } finally {
          await db.query('SELECT pg_advisory_unlock_all()')
          await db.end()
        }
      },
      command: async (id, action, deadline) => {
        if (action === 'START') launches.push({ id, deadline })
        return { status: action === 'STATUS' ? workerState : 'DONE' }
      },
    }
    process.env.AUTOMATIC_MEDIA_PROCESSING_ENABLED = 'true'
    const { maintainSearchBatch, stopSearchBatch } = await import(
      `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text + '\n//# sourceURL=isolated-search-ocr-app.mjs').toString('base64')}`
    )
    await admin.query(`INSERT INTO photos(photo_id,original_stage_path) VALUES(1,'photo1'),(2,'photo2');
    INSERT INTO search_enrichment(photo_id,source_path,status) VALUES(1,'photo1','queued'),(2,'photo2','queued');`)
    await maintainSearchBatch()
    const root = (await query('SELECT * FROM search_batch_runs'))[0]
    assert.deepEqual(root.automatic_photo_ids, [1, 2])
    assert.equal((await query("SELECT * FROM automatic_work_signals WHERE kind='ocr'")).length, 0)
    const image = process.env.SEARCH_RECOVERY_TEST_IMAGE
    const workerNames = []
    const docker = (...args) =>
      execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim()
    async function until(check, timeout = 30000) {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        if (await check()) return
        await delay(100)
      }
      throw new Error('Timed out waiting for worker condition')
    }
    function launchWorker(id, shortLease = false) {
      const name = `stillmark-ocr-fault-${randomUUID()}`
      workerNames.push(name)
      docker(
        'run',
        '-d',
        '--name',
        name,
        '--platform',
        'linux/amd64',
        '--network',
        `container:${containerName}`,
        '--cpus',
        '2',
        '--memory',
        '3g',
        '-e',
        'HF_HUB_OFFLINE=1',
        '-e',
        'TRANSFORMERS_OFFLINE=1',
        '-e',
        'TRAVEL_SUMMARIES_ENABLED=false',
        '-e',
        `SEARCH_UPDATE_DEADLINE=${Math.floor((new Date(root.created_at).getTime() + 10800000) / 1000)}`,
        '-v',
        `${fileURLToPath(new URL('./search-ocr-worker.py', import.meta.url))}:/worker/test_recovery_driver.py:ro`,
        '--entrypoint',
        'python',
        image,
        '/worker/test_recovery_driver.py',
        id,
        ...(shortLease ? ['--short-lease'] : []),
      )
      return name
    }
    try {
      if (image) {
        assert.match(image, /^sha256:[a-f0-9]{64}$/)
        const first = launchWorker(root.id)
        await until(
          async () =>
            Number(
              (await query("SELECT count(*) n FROM search_enrichment WHERE status='running'"))[0].n,
            ) > 0,
        )
        docker('kill', '--signal', 'KILL', first)
      } else {
        await admin.query(
          "UPDATE search_batch_runs SET status='running';UPDATE search_enrichment SET status='running',claim_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',attempts=1 WHERE photo_id=1",
        )
      }
      await admin.query("UPDATE search_batch_runs SET heartbeat_at=now()-interval '3 minutes'")
      workerState = 'FAILED'
      await maintainSearchBatch()
      assert.equal((await query('SELECT status FROM search_batch_runs'))[0].status, 'failed')
      // A live claim prevents a successor even after the backoff, and no new signal is required.
      await admin.query("UPDATE search_batch_runs SET finished_at=now()-interval '2 minutes'")
      await maintainSearchBatch()
      assert.equal((await query('SELECT * FROM search_batch_runs')).length, 1)
      await admin.query(
        "UPDATE search_enrichment SET lease_until=now()-interval '1 second' WHERE status='running'",
      )
      await Promise.all([maintainSearchBatch(), maintainSearchBatch()])
      const child = (await query('SELECT * FROM search_batch_runs WHERE id<>$1', [root.id]))[0]
      assert.ok(child)
      assert.deepEqual(child.automatic_photo_ids, [1, 2])
      assert.equal(
        (await query('SELECT continued_by FROM search_batch_runs WHERE id=$1', [root.id]))[0]
          .continued_by,
        child.id,
      )
      await maintainSearchBatch()
      assert.equal((await query('SELECT * FROM search_batch_runs')).length, 2)
      assert.ok(
        launches
          .filter((x) => x.id === child.id)
          .every((x) => x.deadline === new Date(root.created_at).getTime() + 10800000),
      )
      if (image) {
        workerState = 'PENDING'
        await admin.query('TRUNCATE lease_renewal_evidence')
        const second = launchWorker(child.id, true)
        try {
          await until(
            async () =>
              Number(
                (
                  await query("SELECT count(*) n FROM search_enrichment WHERE status='completed'")
                )[0].n,
              ) === 2,
            150000,
          )
        } catch (e) {
          console.error(docker('logs', second))
          throw e
        }
        await until(
          async () =>
            (await query('SELECT status FROM search_batch_runs WHERE id=$1', [child.id]))[0]
              .status === 'completed',
        )
        const rows = await query(
          'SELECT photo_id,attempts,vector_dims(visual_embedding) dimensions FROM search_enrichment ORDER BY photo_id',
        )
        assert.ok(rows.every((row) => row.dimensions === 512 && row.attempts <= 3))
        const renewals = await query(
          'SELECT photo_id,count(*)::int renewals,extract(epoch from max(lease_until)-min(lease_until))::float seconds FROM lease_renewal_evidence GROUP BY photo_id ORDER BY photo_id',
        )
        assert.ok(
          renewals.some((row) => row.renewals > 2 && row.seconds > 1),
          'Real cold inference must exceed and renew the shortened one-second lease',
        )
        console.log(JSON.stringify({ workerImage: image, completed: rows, renewals }))
      }
      await admin.query(
        "UPDATE search_batch_runs SET status='failed',error='Worker interrupted; automatic recovery pending',finished_at=now()-interval '2 minutes' WHERE id=$1",
        [child.id],
      )
      await stopSearchBatch()
      await maintainSearchBatch()
      assert.equal((await query('SELECT * FROM search_batch_runs')).length, 2)
      console.log(
        JSON.stringify({
          status: 'passed',
          postgresImage: imageId,
          actualWorker: !!image,
          checks: [
            'admission acknowledgement',
            'killed/lost worker reconciliation',
            'live lease fence',
            'single durable successor',
            'original deadline',
            'Stop',
          ],
          limitations: image ? [] : ['actual worker not run in database-only invocation'],
        }),
      )
    } finally {
      for (const name of workerNames) docker('rm', '-f', '-v', name)
    }
  },
  { vector: true },
)
