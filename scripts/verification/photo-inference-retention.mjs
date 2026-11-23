import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withLocalPostgres } from './local-postgres.mjs'

await withLocalPostgres('inference-retention', async ({ admin, connect, imageId }) => {
  await admin.query(`CREATE ROLE personal_photos_app; CREATE ROLE personal_photos_maintenance;
    CREATE SCHEMA photo_security;
    GRANT USAGE ON SCHEMA photo_security TO personal_photos_app,personal_photos_maintenance;
    CREATE FUNCTION photo_security.flag(text) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE TABLE photos(photo_id int PRIMARY KEY,ai_attempts int,ai_error text,ai_next_attempt_at timestamptz,ai_description text,ai_lease_until timestamptz);`)
  for (const migration of [
    '202610291910_photo_inference_receipts',
    '202610292100_photo_inference_retention',
  ]) {
    await admin.query('BEGIN')
    await admin.query(
      readFileSync(new URL(`../../migrations/postgres/${migration}.sql`, import.meta.url), 'utf8'),
    )
    await admin.query('COMMIT')
  }
  const first = await connect('personal_photos_maintenance')
  const second = await connect('personal_photos_maintenance')
  const app = await connect('personal_photos_app')
  const prune = (client) =>
    client.query('SELECT photo_security.prune_photo_inference_receipts(90) n')
  await assert.rejects(prune(app), { code: '42501' })
  await assert.rejects(first.query('SELECT photo_security.prune_photo_inference_receipts(1)'), {
    code: '22023',
  })
  await admin.query(`INSERT INTO photo_inference_receipts(prompt_version,source_path,state,ledger_done,updated_at)
    SELECT i::text,'synthetic','received',true,now()-interval '100 days' FROM generate_series(1,205) i`)
  await first.query('BEGIN')
  assert.equal((await prune(first)).rows[0].n, 100)
  // The first transaction still owns its deleted rows. The second must skip them,
  // not block or claim the same rows. Its driver has a bounded query timeout.
  assert.equal((await prune(second)).rows[0].n, 100)
  await first.query('ROLLBACK')
  assert.equal((await prune(second)).rows[0].n, 100)
  assert.equal((await prune(second)).rows[0].n, 5)
  assert.equal((await prune(second)).rows[0].n, 0)
  console.log('PASS bounded concurrent pruning skips locked rows and rollback preserves receipts')
  await admin.query(`INSERT INTO photo_inference_receipts(prompt_version,source_path,state,ledger_done,updated_at)
    VALUES('late-ledger','synthetic','received',false,now()-interval '100 days')`)
  await first.query('BEGIN')
  await first.query(
    "UPDATE photo_inference_receipts SET ledger_done=true WHERE prompt_version='late-ledger'",
  )
  assert.equal((await prune(second)).rows[0].n, 0)
  await first.query('COMMIT')
  assert.equal((await prune(second)).rows[0].n, 1)
  console.log('PASS in-flight ledger settlement is retained until commit; app role denied')
  console.log(
    JSON.stringify({
      postgres: (await admin.query('SHOW server_version')).rows[0].server_version,
      imageId,
    }),
  )
})
