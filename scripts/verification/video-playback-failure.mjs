/** Real PostgreSQL claim/error publication races; synthetic loopback database only. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { withLocalPostgres } from './local-postgres.mjs'

const bridge = `playback-failure-${randomUUID()}`
const bundled = await build({
  stdin: {
    contents: "export {failPlaybackJob} from './lib/video-playback-queue'",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'local-postgres',
      setup(b) {
        b.onResolve({ filter: /(?:^|\/)postgres$/ }, () => ({
          path: 'postgres',
          namespace: 'local',
        }))
        b.onLoad({ filter: /.*/, namespace: 'local' }, () => ({
          contents: `export const pgQuery=(...a)=>globalThis['${bridge}'].query(...a);export const pgQueryOne=()=>{};export const pgTransaction=()=>{};`,
        }))
      },
    },
  ],
})
await withLocalPostgres('playback-failure', async ({ admin, connect, imageId }) => {
  const worker = await connect()
  const replacement = await connect()
  globalThis[bridge] = worker
  const { failPlaybackJob } = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
  )
  await admin.query(
    `CREATE TABLE video_playback(photo_id int PRIMARY KEY,claim_token uuid,status text,attempts int,lease_until timestamptz,next_attempt_at timestamptz,error text)`,
  )
  const stale = { photo_id: 1, claim_token: randomUUID() }
  const fresh = randomUUID()
  const reset = async (attempts = 1) =>
    admin.query(
      "TRUNCATE video_playback; INSERT INTO video_playback VALUES(1,'" +
        stale.claim_token +
        "','running'," +
        attempts +
        ",now()+interval '5 minutes',now(),'old')",
    )
  await reset()
  // Old failure waits on a concurrent replacement. Postgres must recheck its
  // claim predicate after that transaction commits, including error publication.
  await replacement.query('BEGIN')
  await replacement.query(
    "UPDATE video_playback SET claim_token=$1,status='queued',error='new job' WHERE photo_id=1",
    [fresh],
  )
  let finished = false
  const pending = failPlaybackJob(stale, 'obsolete failure').then(() => (finished = true))
  await delay(100)
  assert.equal(finished, false)
  await replacement.query('COMMIT')
  await pending
  assert.deepEqual(
    (await admin.query('SELECT status,error,claim_token FROM video_playback')).rows[0],
    { status: 'queued', error: 'new job', claim_token: fresh },
  )
  console.log('PASS stale failure cannot overwrite a concurrently replaced queued job')
  for (const status of ['running', 'ready', 'failed']) {
    await admin.query('UPDATE video_playback SET status=$1,error=$2', [status, 'keep'])
    await failPlaybackJob(stale, 'obsolete')
    assert.equal((await admin.query('SELECT error FROM video_playback')).rows[0].error, 'keep')
  }
  console.log('PASS replacement running, ready and failed rows retain their diagnostics')
  await reset()
  await failPlaybackJob(stale, 'encoder failed')
  let row = (await admin.query('SELECT * FROM video_playback')).rows[0]
  assert.equal(row.status, 'queued')
  assert.equal(row.claim_token, null)
  assert.equal(row.lease_until, null)
  assert.equal(row.error, 'encoder failed')
  assert.ok(row.next_attempt_at.getTime() > Date.now() + 8000)
  await reset(3)
  await failPlaybackJob(stale, 'x'.repeat(1500))
  row = (await admin.query('SELECT * FROM video_playback')).rows[0]
  assert.equal(row.status, 'failed')
  assert.equal(row.error.length, 1000)
  await reset()
  await failPlaybackJob(stale)
  assert.match(
    (await admin.query('SELECT error FROM video_playback')).rows[0].error,
    /original playback remains available/,
  )
  console.log(JSON.stringify({ ok: true, checks: 6, postgresImage: imageId }))
  delete globalThis[bridge]
})
