/** Disposable native Postgres test; never connects to a remote database. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'
import { withLocalPostgres } from './local-postgres.mjs'

const { code } = await transform(
  readFileSync(new URL('../../lib/search/search-update.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'esm' },
)
const { searchUpdateChainSql, searchUpdateChildSql, searchUpdatePlan } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
)
await withLocalPostgres('search-update', async ({ admin, connect }) => {
  await admin.query(`CREATE ROLE search_test;
    CREATE TABLE search_batch_runs(id text PRIMARY KEY, requested_by text, status text DEFAULT 'completed', photo_limit int, search_limit int, photos_done int DEFAULT 0, elapsed_ms int DEFAULT 0, created_at timestamptz DEFAULT clock_timestamp(), continued_by text REFERENCES search_batch_runs(id), pipeline_error text, automatic_photo_ids int[]);
    GRANT SELECT,INSERT,UPDATE ON search_batch_runs TO search_test;
    INSERT INTO search_batch_runs(id,photo_limit,search_limit,photos_done,created_at) VALUES('root',10000,20,5000,now()-interval '1 hour');`)
  const a = await connect('search_test')
  const b = await connect('search_test')
  const lock = "SELECT pg_try_advisory_lock(hashtextextended('search-batch-pipeline',0)) AS locked"
  const unlock = "SELECT pg_advisory_unlock(hashtextextended('search-batch-pipeline',0))"
  assert.equal((await a.query(lock)).rows[0].locked, true)
  assert.equal((await b.query(lock)).rows[0].locked, false)
  await a.query("UPDATE search_batch_runs SET automatic_photo_ids=ARRAY[11,12] WHERE id='root'")
  await a.query(searchUpdateChildSql, ['child', 'owner', 5000, 20, 'root'])
  assert.deepEqual(
    (await a.query("SELECT automatic_photo_ids FROM search_batch_runs WHERE id='child'")).rows[0]
      .automatic_photo_ids,
    [11, 12],
    'Continuation must preserve the automatic upload scope',
  )
  await a.query(unlock)
  assert.equal((await b.query(lock)).rows[0].locked, true)
  // A second maintenance tick cannot insert another child of the same run.
  assert.equal(
    (await b.query(searchUpdateChildSql, ['duplicate', 'owner', 5000, 20, 'root'])).rowCount,
    0,
  )
  assert.equal((await b.query("SELECT id FROM search_batch_runs WHERE id='duplicate'")).rowCount, 0)
  await b.query(unlock)
  // Connection loss after commit leaves both the link and the child recoverable.
  const chain = (await b.query(searchUpdateChainSql, ['child'])).rows
  assert.equal(chain.length, 2)
  assert.equal(searchUpdatePlan(chain, 5000).remaining, 5000)
  assert.equal(
    searchUpdatePlan(chain, 5000).deadline,
    new Date(chain[1].created_at).getTime() + 10800000,
  )
  await b.query("UPDATE search_batch_runs SET status='cancelled' WHERE id='child'")
  assert.equal(
    (await b.query(searchUpdateChildSql, ['after-stop', 'owner', 5000, 20, 'child'])).rowCount,
    0,
  )
  console.log(
    'PASS native Postgres: serialized launch, atomic child/link, idempotent continuation, deadline inheritance and Stop fence',
  )
})
