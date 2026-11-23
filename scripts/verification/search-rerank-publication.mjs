/** Native Postgres publication fences; extracts the actual Python worker SQL. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const root = process.env.STILLMARK_RERANK_SOURCE_ROOT || process.cwd()
const { withLocalPostgres } = await import(
  resolve(process.cwd(), 'scripts/verification/local-postgres.mjs')
)
const statements = JSON.parse(
  execFileSync(
    'python3',
    [
      '-c',
      `
import ast,json,sys
tree=ast.parse(open(sys.argv[1]).read())
fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='publish_rerank')
print(json.dumps([n.args[0].value for n in ast.walk(fn) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='execute']))
`,
      resolve(root, 'workers/search-cpu/worker.py'),
    ],
    { encoding: 'utf8' },
  ),
)
const pgSql = (sql) => {
  let n = 0
  return sql.replaceAll('%s', () => '$' + ++n)
}
const [publish, release] = statements.map(pgSql)
assert.equal(statements.length, 2)

await withLocalPostgres('rerank-publication', async ({ admin, connect, imageId }) => {
  await admin.query(`
    CREATE TABLE revisions(revision text NOT NULL); INSERT INTO revisions VALUES('v1');
    CREATE FUNCTION search_scope_revision(int[], text) RETURNS text LANGUAGE sql AS $$SELECT revision FROM revisions$$;
    CREATE TABLE search_batch_runs(id uuid PRIMARY KEY,status text NOT NULL);
    CREATE TABLE search_sessions(id uuid PRIMARY KEY,username text,scope_ids int[],scope_revision text,
      reranked_ids int[],rerank_model text,rerank_status text,rerank_error text,
      claim_token uuid,lease_until timestamptz,attempts int,expires_at timestamptz);
    CREATE ROLE personal_photos_search_worker;
    ALTER TABLE search_sessions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE search_sessions FORCE ROW LEVEL SECURITY;
    CREATE POLICY search_session_worker ON search_sessions TO personal_photos_search_worker
      USING(expires_at>now()) WITH CHECK(expires_at>now());
    GRANT SELECT ON search_sessions,search_batch_runs,revisions TO personal_photos_search_worker;
    GRANT UPDATE(reranked_ids,rerank_model,rerank_status,rerank_error,claim_token,lease_until,attempts)
      ON search_sessions TO personal_photos_search_worker;
  `)
  const worker = await connect('personal_photos_search_worker')
  const scenarios = [
    'success',
    'scope-changed',
    'expired-lease',
    'cancelled-run',
    'replacement-claim',
    'replayed-session',
    'retry-exhausted',
    'expired-session',
  ]
  for (const scenario of scenarios) {
    const id = randomUUID()
    const token = randomUUID()
    const replacement = randomUUID()
    const run = randomUUID()
    await admin.query("UPDATE revisions SET revision='v1'")
    await admin.query("INSERT INTO search_batch_runs VALUES($1,'running')", [run])
    await admin.query(
      `INSERT INTO search_sessions VALUES($1,'owner',ARRAY[1],'v1',NULL,NULL,'running',NULL,$2,now()+interval '15 minutes',1,now()+interval '14 days')`,
      [id, token],
    )
    if (scenario === 'scope-changed') await admin.query("UPDATE revisions SET revision='v2'")
    if (scenario === 'expired-lease')
      await admin.query(
        "UPDATE search_sessions SET lease_until=now()-interval '1 second' WHERE id=$1",
        [id],
      )
    if (scenario === 'cancelled-run')
      await admin.query("UPDATE search_batch_runs SET status='cancelled' WHERE id=$1", [run])
    if (scenario === 'replacement-claim')
      await admin.query('UPDATE search_sessions SET claim_token=$2 WHERE id=$1', [id, replacement])
    if (scenario === 'replayed-session')
      await admin.query(
        "UPDATE search_sessions SET claim_token=NULL,rerank_status='queued',attempts=0,scope_revision='v2' WHERE id=$1",
        [id],
      )
    if (scenario === 'retry-exhausted')
      await admin.query(
        "UPDATE search_sessions SET attempts=3,lease_until=now()-interval '1 second' WHERE id=$1",
        [id],
      )
    if (scenario === 'expired-session')
      await admin.query(
        "UPDATE search_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
        [id],
      )
    const before = (await admin.query('SELECT * FROM search_sessions WHERE id=$1', [id])).rows[0]
    const published = await worker.query(publish, [[2, 1], 'test-ranker', id, token, run])
    if (!published.rowCount) await worker.query(release, [id, token])
    const after = (await admin.query('SELECT * FROM search_sessions WHERE id=$1', [id])).rows[0]
    assert.equal(published.rowCount, scenario === 'success' ? 1 : 0, scenario)
    if (
      scenario === 'replacement-claim' ||
      scenario === 'replayed-session' ||
      scenario === 'expired-session'
    )
      assert.deepEqual(after, before, scenario)
    else {
      assert.equal(after.claim_token, null, scenario)
      assert.equal(after.lease_until, null, scenario)
      assert.equal(
        after.rerank_status,
        scenario === 'success' ? 'completed' : scenario === 'retry-exhausted' ? 'failed' : 'queued',
        scenario,
      )
      assert.deepEqual(after.reranked_ids, scenario === 'success' ? [2, 1] : null, scenario)
    }
  }
  console.log(JSON.stringify({ test: 'rerank-publication', scenarios, imageId, result: 'passed' }))
})
