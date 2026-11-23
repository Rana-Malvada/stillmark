/** Exercise the real read-only sampler against disposable native PostgreSQL. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withLocalPostgres } from './local-postgres.mjs'

const sql = readFileSync(new URL('../load-test/database-sample.sql', import.meta.url), 'utf8')
await withLocalPostgres('load-monitor', async ({ admin }) => {
  await admin.query(`CREATE TABLE upload_processing_jobs (
    state text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  )`)
  const sample = async () => Object.values((await admin.query(sql)).rows[0])[0]
  const empty = await sample()
  assert.equal(empty.queued, 0)
  assert.equal(empty.processing, 0)
  assert.equal(empty.oldestUploadAgeSeconds, 0)
  assert.ok(empty.connections >= 1)
  await admin.query(`INSERT INTO upload_processing_jobs(state,created_at) VALUES
    ('queued',now()-interval '90 seconds'),
    ('processing',now()-interval '120 seconds'),
    ('done',now()-interval '1 day'),
    ('failed',now()-interval '2 days')`)
  const pending = await sample()
  assert.equal(pending.queued, 1)
  assert.equal(pending.processing, 1)
  assert.ok(pending.oldestUploadAgeSeconds >= 120 && pending.oldestUploadAgeSeconds < 125)
  await admin.query("UPDATE upload_processing_jobs SET state='done'")
  assert.equal((await sample()).oldestUploadAgeSeconds, 0)
  await admin.query(
    "INSERT INTO upload_processing_jobs VALUES ('queued',now()+interval '1 minute')",
  )
  assert.equal((await sample()).oldestUploadAgeSeconds, 0)
  await admin.query('BEGIN READ ONLY')
  assert.equal((await sample()).queued, 1)
  await admin.query('ROLLBACK')
  console.log('PASS native load sampler: empty, queued, processing, terminal, future, read-only')
})
