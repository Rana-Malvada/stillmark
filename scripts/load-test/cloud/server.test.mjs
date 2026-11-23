import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { cloudRunLimits, validateCloudRun } from './server.mjs'

const fixture = { name: 'synthetic-1.jpg', size: 100, sha256: 'a'.repeat(64) }
const origin = 'https://isolated.example.test'
function request() {
  return {
    config: {
      origin,
      runId: 'cloud-test-01',
      users: 1,
      filesPerUser: 1,
      maxRequests: 2,
      maxSeconds: 60,
      rampSeconds: 0,
      pollMs: 1000,
      maxBytes: 100,
    },
    actors: [{ username: 'test', eventId: 1 }],
    key: 'k'.repeat(32),
    attestationEnvelope: { payload: 'signed' },
  }
}
test('accepts bounded isolated cloud plan', () =>
  assert.equal(validateCloudRun(request(), [fixture], origin).files, 1))
test('rejects alternate origin and excess cloud duration', () => {
  assert.throws(() => validateCloudRun(request(), [fixture], 'https://another.test'))
  const body = request()
  body.config.maxSeconds = 901
  assert.throws(() => validateCloudRun(body, [fixture], origin))
})
test('requires operator attestation and bounds transfer bytes', () => {
  const body = request()
  delete body.attestationEnvelope
  assert.throws(() => validateCloudRun(body, [fixture], origin))
  const big = request()
  big.config.maxBytes = 5 * 1024 ** 3
  assert.throws(() => validateCloudRun(big, [fixture], origin))
})

test('fault supervisor refuses a non-test database before launching a worker', async () => {
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(
    process.execPath,
    // A URL pathname is percent-encoded; convert it so checkout paths with spaces work.
    [fileURLToPath(new URL('./fault-worker.mjs', import.meta.url))],
    {
      env: {
        ...process.env,
        PG_DATABASE: 'production',
        SNOWFLAKE_DATABASE: 'STILLMARK_LOADTEST_BASELINE',
        UPLOAD_QUEUE_DIAGNOSTICS: 'true',
        LOAD_TEST_CRASH_ONCE: 'true',
      },
      encoding: 'utf8',
    },
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Isolated crash test only/)
})

test('accepts 250 distinct users but rejects 251 and excessive requests', () => {
  const body = request()
  body.actors = Array.from({ length: 251 }, (_, i) => ({ username: `test${i}`, eventId: i + 1 }))
  body.config.users = 250
  body.config.maxBytes = 25000
  body.config.maxRequests = 256
  assert.equal(validateCloudRun(body, [fixture], origin).users, 250)
  body.config.users = 251
  body.config.maxBytes = 25100
  assert.throws(() => validateCloudRun(body, [fixture], origin))
  body.config.users = 250
  body.config.maxRequests = 257
  assert.throws(() => validateCloudRun(body, [fixture], origin))
})

test('mixed cloud plans account for reads and reject unknown workload modes', () => {
  const body = request()
  body.config.workload = 'unknown'
  assert.throws(() => validateCloudRun(body, [fixture], origin))
  body.config = {
    ...body.config,
    workload: 'mixed',
    uploadUsers: 0,
    uploadRounds: 1,
    durationSeconds: 10,
    warmupSeconds: 1,
    thinkMs: 500,
    readRequestBudget: 1000,
    maxReadBytes: 100000,
  }
  body.actors[0].browseEventId = 2
  assert.equal(validateCloudRun(body, [fixture], origin).maxReadBytes, 100000)
  body.config.maxReadBytes = 5 * 1024 ** 3
  assert.throws(() => validateCloudRun(body, [fixture], origin))
})

test('permits an explicit bounded 500-user profile without widening defaults', () => {
  const limits = cloudRunLimits({
    LOAD_TEST_MAX_USERS: '500',
    LOAD_TEST_MAX_REQUESTS: '512',
    LOAD_TEST_MAX_READ_BYTES: String(8 * 1024 ** 3),
  })
  const body = request()
  body.actors = Array.from({ length: 500 }, (_, i) => ({ username: `test${i}`, eventId: i + 1 }))
  body.config.users = 500
  body.config.maxBytes = 50000
  body.config.maxRequests = 512
  assert.throws(() => validateCloudRun(body, [fixture], origin))
  assert.equal(validateCloudRun(body, [fixture], origin, limits).users, 500)
  for (const env of [
    { LOAD_TEST_MAX_USERS: '5001' },
    { LOAD_TEST_MAX_REQUESTS: '1025' },
    { LOAD_TEST_MAX_READ_BYTES: '0' },
    { LOAD_TEST_MAX_USERS: '1.5' },
  ])
    assert.throws(() => cloudRunLimits(env))
})
