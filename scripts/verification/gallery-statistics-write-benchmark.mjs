/** Synthetic local full-schema comparison; never connects to a remote database. */
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { withLocalPostgres } from './local-postgres.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
await withLocalPostgres('statistics-write-benchmark', async ({ admin }) => {
  await admin.query(
    'CREATE ROLE snowflake_admin;CREATE ROLE personal_photos_app NOINHERIT;CREATE ROLE personal_photos_reader;CREATE ROLE personal_photos_video_worker;CREATE ROLE personal_photos_maintenance;CREATE ROLE personal_photos_search_worker;',
  )
  await admin.query(read('../../tests/fixtures/rls-schema.sql'))
  await admin.query('SET search_path=public')
  await admin.query(read('../../setup/72-app-rls.sql'))
  await admin.query(
    "INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES(1,1,'Synthetic album','synthetic','ALICE','PRIVATE')",
  )
  const insert = `INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,display_stage_path) SELECT i,1,'photo-'||i||'.jpg','photo','READY','display/'||i||'.jpg' FROM generate_series(1,4) i`
  const results = {}
  for (const label of ['previousSchema', 'statistics']) {
    if (label === 'statistics')
      await admin.query(
        'BEGIN;' +
          read('../../migrations/postgres/202610311200_gallery_statistics.sql') +
          'COMMIT;',
      )
    const samples = []
    for (let i = 0; i < 120; i++) {
      await admin.query('BEGIN')
      const start = performance.now()
      await admin.query(insert)
      const elapsed = performance.now() - start
      await admin.query('ROLLBACK')
      if (i >= 20) samples.push(elapsed)
    }
    samples.sort((a, b) => a - b)
    results[label] = { medianMs: samples[50], p95Ms: samples[94] }
  }
  console.log(JSON.stringify(results))
})
