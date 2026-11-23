#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import pg from 'pg'
import { summarizeTimings } from './timings.mjs'

async function main() {
  const [summaryPath, outputPath] = process.argv.slice(2)
  if (!summaryPath || !outputPath)
    throw Error('Usage: collect-timings.mjs SUMMARY.json OUTPUT.json')
  const run = JSON.parse(await readFile(summaryPath, 'utf8'))
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(run.runId ?? '')) throw Error('Missing run ID')
  const ids = run.results.map((r) => r.uploadId)
  if (ids.length === 0 || ids.length > 100000 || ids.some((id) => !/^[a-f0-9-]{36}$/i.test(id)))
    throw Error('Invalid upload IDs')
  // Explicit environment connection only; never fall back to the production libpq service.
  if (
    !process.env.PGHOST ||
    !process.env.PGUSER ||
    !/^stillmark_loadtest_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '')
  )
    throw Error('Explicit isolated Postgres connection required')
  // node-postgres does not load libpq's PGSSLROOTCERT automatically.
  // Preserve certificate and hostname validation with the supplied managed-PG CA.
  const client = new pg.Client({
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
    ...(process.env.PGSSLROOTCERT
      ? {
          ssl: {
            ca: await readFile(process.env.PGSSLROOTCERT, 'utf8'),
            rejectUnauthorized: true,
          },
        }
      : {}),
  })
  await client.connect()
  let report
  try {
    await client.query('BEGIN READ ONLY')
    const identity = (
      await client.query('SELECT current_database() database,pg_is_in_recovery() recovery')
    ).rows[0]
    if (identity.database !== process.env.PGDATABASE || identity.recovery)
      throw Error('Wrong or read-only replica database')
    const { rows } = await client.query(
      'SELECT run_id,upload_id,state,attempt,executor,occurred_at,sequence FROM loadtest_control.transitions WHERE upload_id=ANY($1::uuid[]) ORDER BY sequence',
      [ids],
    )
    if (!rows.length || rows.some((r) => r.run_id !== run.runId))
      throw Error('Expected exactly one test run')
    report = summarizeTimings(
      rows.map((r) => ({ ...r, occurred_at: r.occurred_at.toISOString() })),
      ids,
    )
    report.allComplete = report.allComplete && run.passed === true && run.plan.files === ids.length
    report.plannedFiles = run.plan.files
    await client.query('COMMIT')
  } finally {
    await client.end()
  }
  await writeFile(outputPath, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' })
  console.log(
    JSON.stringify({
      expected: report.expected,
      completed: report.completed,
      allComplete: report.allComplete,
    }),
  )
  if (!report.allComplete) process.exitCode = 1
}
main().catch(() => {
  console.error('Timing collection failed; verify isolated database, permissions, and run IDs.')
  process.exitCode = 1
})
