import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { createPhotoAiListener } from '../../lib/photos/photo-ai-listener.ts'
import { withLocalPostgres } from './local-postgres.mjs'

await withLocalPostgres('photo-notifications', async ({ admin, connect }) => {
  await admin.query(`CREATE TABLE photos(photo_id serial primary key, ingest_status text DEFAULT 'PENDING',
    media_type text DEFAULT 'photo', display_stage_path text, ai_description text, ai_attempts int DEFAULT 0)`)
  const worker = await connect()
  const processed = new Set()
  let drains = 0
  let listener
  const sync = createPhotoAiListener(
    () => {
      const { host, port, user, database } = admin.connectionParameters
      listener = new pg.Client({ host, port, user, database })
      return listener
    },
    async () => {
      drains++
      const result = await worker.query(`UPDATE photos SET ai_description='described' WHERE
      ai_description IS NULL AND media_type='photo' AND ingest_status='READY'
      AND display_stage_path IS NOT NULL AND ai_attempts<3 RETURNING photo_id`)
      for (const { photo_id } of result.rows) processed.add(photo_id)
    },
  )
  const ready =
    "UPDATE photos SET ingest_status='READY',display_stage_path='display/test' WHERE photo_id=$1"
  async function upload(client = admin) {
    await client.query('BEGIN')
    const {
      rows: [{ photo_id }],
    } = await client.query('INSERT INTO photos DEFAULT VALUES RETURNING photo_id')
    await client.query(ready, [photo_id])
    await client.query('COMMIT')
    return photo_id
  }
  async function until(predicate) {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return
      await delay(10)
    }
    assert.fail('Timed out waiting for worker')
  }
  try {
    await admin.query('BEGIN')
    await admin.query(
      readFileSync(
        new URL('../../migrations/postgres/202611131800_photo_ai_notify.sql', import.meta.url),
        'utf8',
      ),
    )
    await admin.query('COMMIT')
    await sync(true)
    await admin.query('BEGIN')
    await admin.query("INSERT INTO photos(ingest_status,display_stage_path) VALUES ('READY','x')")
    await delay(30)
    assert.equal(drains, 1)
    await admin.query('ROLLBACK')
    await admin.query(
      "INSERT INTO photos(ingest_status,display_stage_path,media_type) VALUES ('READY','x','video')",
    )
    const first = await upload()
    await until(() => processed.has(first))
    assert.equal(drains, 2)
    // Simulate worker exit, commit while offline, then start another listener session.
    const previous = listener
    await sync(false)
    const missed = await Promise.all([upload(), upload(worker)])
    assert.equal(processed.size, 1)
    await sync(true)
    assert.notEqual(listener, previous)
    await until(() => missed.every((id) => processed.has(id)))
    const pid = listener.processID
    const ended = new Promise((resolve) => listener.once('end', resolve))
    await admin.query('SELECT pg_terminate_backend($1)', [pid])
    await ended
    const disconnected = await upload()
    await sync(true)
    await until(() => processed.has(disconnected))
    const next = await upload()
    await until(() => processed.has(next))
    assert.equal(processed.size, 5)
    console.log(
      'PASS post-commit dispatch, rollback, video exclusion, restart backlog and disconnected listener recovery',
    )
    // Measure concurrent metadata upload transactions with and without the trigger.
    // Keep AI work independent and identical during both measurements.
    await sync(false)
    const sink = createPhotoAiListener(
      () =>
        new pg.Client({
          host: admin.host,
          port: admin.port,
          user: admin.user,
          database: admin.database,
        }),
      async () => {},
    )
    await sink(true)
    try {
      const writers = await Promise.all(Array.from({ length: 4 }, () => connect()))
      const samples = { enabled: [], disabled: [] }
      for (const mode of ['enabled', 'disabled', 'disabled', 'enabled']) {
        await admin.query(
          'ALTER TABLE photos ' +
            (mode === 'enabled' ? 'ENABLE' : 'DISABLE') +
            ' TRIGGER notify_ready_photo_ai',
        )
        await Promise.all(
          writers.map(async (writer) => {
            for (let i = 0; i < 55; i++) {
              const start = performance.now()
              await upload(writer)
              if (i >= 5) samples[mode].push(performance.now() - start)
            }
          }),
        )
      }
      for (const [mode, times] of Object.entries(samples)) {
        times.sort((a, b) => a - b)
        console.log(
          mode,
          times.length,
          'commits; p50',
          times[Math.floor(times.length * 0.5)].toFixed(2),
          'ms; p95',
          times[Math.floor(times.length * 0.95)].toFixed(2),
          'ms',
        )
      }
    } finally {
      await sink(false)
    }
  } finally {
    await sync(false)
  }
})
