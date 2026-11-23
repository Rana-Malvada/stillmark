/** Run the production backup verifier on a disposable synthetic catalog only. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import pg from 'pg'
import { withLocalPostgres } from './local-postgres.mjs'
import { createPermissionFixture } from './permission-fixture.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
await withLocalPostgres(
  'backup-restore',
  async ({ admin, clients }) => {
    const database = 'gallery_backup_fixture_' + randomUUID().replaceAll('-', '')
    await admin.query(`CREATE DATABASE "${database}"`)
    const db = new pg.Client({
      host: '127.0.0.1',
      port: admin.connectionParameters.port,
      user: 'postgres',
      database,
      statement_timeout: 10000,
      connectionTimeoutMillis: 1000,
    })
    clients.add(db)
    await db.connect()
    await createPermissionFixture(db)
    await db.query(`CREATE SCHEMA IF NOT EXISTS face_worker; CREATE SCHEMA release_control;
      INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility)
        VALUES(90001,0,'Synthetic restore fixture','synthetic-restore','RESTORE_FIXTURE','PRIVATE');
      INSERT INTO photos(photo_id,event_id,source_filename,ingest_status)
        VALUES(90001,90001,'synthetic.jpg','DISCOVERED');`)
    const directory = path.join(root, '.release', 'backup-checks', randomUUID())
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const serviceFile = path.join(directory, 'pg_service.conf')
    writeFileSync(
      serviceFile,
      `[isolated_backup]\nhost=127.0.0.1\nport=${admin.connectionParameters.port}\nuser=postgres\ndbname=${database}\nsslmode=disable\n`,
      { mode: 0o600 },
    )
    // Do not inherit production libpq identity, password, options or service.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('PG') && key !== 'GALLERY_PG_SERVICE',
      ),
    )
    Object.assign(env, {
      PGSERVICEFILE: serviceFile,
      PGPASSFILE: path.join(directory, 'unused-passfile'),
      GALLERY_PG_SERVICE: 'isolated_backup',
    })
    const output = execFileSync('python3', [path.join(root, 'scripts/verify-backup.py')], {
      cwd: directory,
      env,
      encoding: 'utf8',
      timeout: 120000,
    })
    writeFileSync(path.join(directory, 'result.json'), output, { mode: 0o600 })
    const result = JSON.parse(output)
    assert.equal(result.restored, true)
    assert.equal(result.sourceDatabase, database)
    assert.equal(result.unscopedPhotos, 0)
    assert.equal(result.orphanPhotos, 0)
    assert.equal(result.counts.photos, 1)
    assert.equal(result.counts.events, 1)
    assert.ok(result.securityFunctions >= 10)
    assert.deepEqual(result.excludedOperationalExtensions, [])
    assert.equal(
      (
        await admin.query(
          "SELECT datname FROM pg_database WHERE datname LIKE 'gallery_restore_check_%'",
        )
      ).rowCount,
      0,
    )
    console.log(
      `PASS: actual portable backup/restore, current RLS owner/viewer/read-only/share/revoke checks and scoped cleanup; evidence: ${directory}`,
    )
  },
  { vector: true },
)
