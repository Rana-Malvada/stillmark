import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { summarizeTimings } from './timings.mjs'

const ddl = await readFile(new URL('./install-telemetry.sql', import.meta.url), 'utf8')
const fixture = `CREATE TABLE events(event_id bigint PRIMARY KEY,owner_username text,visibility text);
CREATE TABLE photos(photo_id bigint,event_id bigint,ai_description text);
CREATE TABLE upload_processing_jobs(upload_id uuid PRIMARY KEY,owner text,body jsonb,state text,attempts integer,executor text);`
const id = '00000000-0000-4000-8000-000000000001'
test('installer refuses production database', async () => {
  const db = new PGlite()
  try {
    await db.exec(fixture)
    await assert.rejects(db.exec(ddl), /Refusing non-test/)
  } finally {
    await db.close()
  }
})
test('isolated recorder preserves retries, skips heartbeat noise and suppresses fixture AI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loadtest-pg-'))
  const bootstrap = new PGlite(dir)
  await bootstrap.exec('CREATE DATABASE stillmark_loadtest_local')
  await bootstrap.close()
  const db = new PGlite(dir, { database: 'stillmark_loadtest_local' })
  try {
    await db.exec(fixture)
    await db.exec(ddl)
    await db.exec(
      `INSERT INTO events VALUES(1,'test-user','PRIVATE');INSERT INTO loadtest_control.runs(run_id,expires_at) VALUES('test-run-001',now()+interval '1 hour');INSERT INTO loadtest_control.actors VALUES('test-run-001','test-user',1);`,
    )
    await db.query(
      `INSERT INTO upload_processing_jobs VALUES($1,'test-user','{"eventId":1}','queued',0,NULL)`,
      [id],
    )
    await db.exec(
      `UPDATE upload_processing_jobs SET state='processing',attempts=1,executor='pool';UPDATE upload_processing_jobs SET executor='pool';UPDATE upload_processing_jobs SET state='queued';UPDATE upload_processing_jobs SET state='processing',attempts=2;UPDATE upload_processing_jobs SET state='done';`,
    )
    const { rows } = await db.query('SELECT * FROM loadtest_control.transitions ORDER BY sequence')
    assert.equal(rows.length, 5)
    const report = summarizeTimings(
      rows.map((r) => ({ ...r, occurred_at: new Date(r.occurred_at).toISOString() })),
      [id],
    )
    assert.equal(report.allComplete, true)
    assert.equal(report.jobs[0].attempts.length, 2)
    assert.equal(report.jobs[0].attempts[0].outcome, 'retry')
    await db.exec('INSERT INTO photos VALUES(1,1,NULL)')
    assert.match(
      (await db.query('SELECT ai_description FROM photos')).rows[0].ai_description,
      /AI disabled/,
    )
    await assert.rejects(db.exec('INSERT INTO photos VALUES(2,2,NULL)'), /outside the isolated/)
    await assert.rejects(
      db.query(
        `INSERT INTO upload_processing_jobs VALUES($1,'wrong','{"eventId":1}','queued',0,NULL)`,
        ['00000000-0000-4000-8000-000000000002'],
      ),
      /outside the isolated/,
    )
  } finally {
    await db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
test('collector reports incomplete and rejects unrelated IDs', () => {
  assert.equal(summarizeTimings([], [id]).allComplete, false)
  assert.throws(() => summarizeTimings([{ upload_id: 'other' }], [id]), /outside run/)
})

test('timings keep reclaimed leases distinct and refuse false completion', () => {
  const row = (sequence, state, attempt, ms) => ({
    upload_id: id,
    sequence,
    state,
    attempt,
    executor: 'pool',
    occurred_at: new Date(1700000000000 + ms).toISOString(),
  })
  const report = summarizeTimings(
    [
      row(1, 'queued', 0, 0),
      row(2, 'processing', 1, 100),
      row(3, 'processing', 2, 300100),
      row(4, 'done', 2, 301100),
    ],
    [id],
  )
  assert.equal(report.allComplete, true)
  assert.equal(report.jobs[0].attempts[0].outcome, 'lease_reclaimed')
  assert.equal(report.jobs[0].attempts[0].queueMs, 100)
  assert.equal(report.jobs[0].attempts[1].queueMs, null)
  assert.equal(report.jobs[0].attempts[1].processingMs, 1000)
  assert.equal(summarizeTimings([row(1, 'done', 1, 1)], [id]).allComplete, false)
})

test('installer refuses a populated test database without adding telemetry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loadtest-populated-'))
  const bootstrap = new PGlite(dir)
  await bootstrap.exec('CREATE DATABASE stillmark_loadtest_populated')
  await bootstrap.close()
  const db = new PGlite(dir, { database: 'stillmark_loadtest_populated' })
  try {
    await db.exec(fixture)
    await db.exec('INSERT INTO photos VALUES(1,1,NULL)')
    await assert.rejects(db.exec(ddl), /must have no media/)
    await db.exec('ROLLBACK')
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM pg_namespace WHERE nspname='loadtest_control'"))
        .rows[0].n,
      0,
    )
  } finally {
    await db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
