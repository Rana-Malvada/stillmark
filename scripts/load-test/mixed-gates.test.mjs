import test from 'node:test'
import assert from 'node:assert/strict'
import { assessMixed, generatorCpuWindows } from './mixed-gates.mjs'

const good = () => ({
  summary: {
    passed: true,
    capacityEligible: true,
    measurementStartedAt: new Date(1000).toISOString(),
    measurementEndsAt: new Date(11000).toISOString(),
    operations: Object.fromEntries(
      [
        'albums',
        'album_page',
        'album_thumbnail',
        'photos',
        'photo_page',
        'thumbnail',
        'photo_detail',
        'display',
      ].map((x) => [
        'measured:' + x,
        { count: 50, errors: 0, endToEnd: { p95Ms: 200, p99Ms: 300 }, generatorWait: { p95Ms: 2 } },
      ]),
    ),
  },
  samples: Array.from({ length: 11 }, (_, i) => ({
    at: 1000 + i * 1000,
    cpu: { user: i * 1000, system: i * 1000 },
    memory: { rss: 100000 },
  })),
})
test('capacity gates require measured operations, generator headroom and drained queue', () => {
  const db = [1000, 6000, 11000].map((at) => ({
    at: new Date(at).toISOString(),
    connections: 20,
    queued: 0,
    processing: 0,
    oldestUploadAgeSeconds: 0,
  }))
  assert.equal(assessMixed(good(), db).passed, true)
  const r = good()
  r.summary.operations['measured:display'].endToEnd = { p95Ms: 3000, p99Ms: 3500 }
  assert.ok(assessMixed(r, db).reasons.includes('display:latency'))
  assert.ok(
    assessMixed(good(), [
      { connections: 450, queued: 1, processing: 0, oldestUploadAgeSeconds: 0 },
    ]).reasons.includes('queue_not_drained'),
  )
  assert.equal(assessMixed(good(), []).passed, false)
  const early = good()
  early.summary.capacityEligible = false
  assert.equal(assessMixed(early, db).passed, false)
})

test('missing latency and database counters cannot pass capacity gates', () => {
  const r = good()
  delete r.summary.operations['measured:display'].endToEnd.p95Ms
  assert.equal(
    assessMixed(r, [{ connections: 20, queued: 0, processing: 0, oldestUploadAgeSeconds: 0 }])
      .passed,
    false,
  )
  assert.equal(assessMixed(good(), [{}]).passed, false)
})

test('capacity requires enough finite generator samples to assess CPU', () => {
  const r = good()
  r.samples = r.samples.slice(0, 2)
  assert.equal(
    assessMixed(r, [{ connections: 20, queued: 0, processing: 0, oldestUploadAgeSeconds: 0 }])
      .passed,
    false,
  )
})

test('successful recovery does not hide failed upload attempts from strict capacity gates', () => {
  const r = good()
  r.summary.upload = { rounds: [{ passed: true, requestErrorCount: 1 }] }
  assert.ok(
    assessMixed(r, [
      { connections: 20, queued: 0, processing: 0, oldestUploadAgeSeconds: 0 },
    ]).reasons.includes('upload_request_errors'),
  )
})

test('CPU headroom uses verified allocation without changing the utilization threshold', () => {
  const r = good()
  const db = [1000, 6000, 11000].map((at) => ({
    at: new Date(at).toISOString(),
    connections: 20,
    queued: 0,
    processing: 0,
    oldestUploadAgeSeconds: 0,
  }))
  for (let i = 0; i < r.samples.length; i++) r.samples[i].cpu = { user: i * 1200000, system: 0 }
  assert.ok(assessMixed(r, db).reasons.includes('generator_cpu'))
  const two = assessMixed(r, db, undefined, { cpuCores: 2 })
  assert.equal(two.passed, true)
  assert.equal(two.limits.maxGeneratorCpuFraction, 0.8)
  for (let i = 0; i < r.samples.length; i++) r.samples[i].cpu.user = i * 1700000
  assert.ok(assessMixed(r, db, undefined, { cpuCores: 2 }).reasons.includes('generator_cpu'))
  for (const cpuCores of [0, -1, NaN, Infinity, 65, '2', undefined])
    assert.ok(
      assessMixed(good(), db, undefined, { cpuCores }).reasons.includes(
        'invalid_generator_allocation',
      ),
    )
  // Result-supplied claims must not override independently verified resources.
  r.resources = { cpuCores: 64 }
  assert.ok(assessMixed(r, db).reasons.includes('generator_cpu'))
})

test('fast p95 cannot hide a slow p99 or missing tail measurements', () => {
  const db = [1000, 6000, 11000].map((at) => ({
    at: new Date(at).toISOString(),
    connections: 20,
    queued: 0,
    processing: 0,
    oldestUploadAgeSeconds: 0,
  }))
  const r = good()
  r.summary.operations['measured:photos'].endToEnd.p99Ms = 2001
  assert.ok(assessMixed(r, db).reasons.includes('photos:tail_latency'))
  delete r.summary.operations['measured:photos'].endToEnd.p99Ms
  assert.ok(assessMixed(r, db).reasons.includes('photos:invalid_metrics'))
  r.summary.operations['measured:photos'].endToEnd.p99Ms = 100
  assert.ok(assessMixed(r, db).reasons.includes('photos:invalid_metrics'))
})

test('a drained queue does not hide an earlier stalled or excessive backlog', () => {
  const drained = { connections: 20, queued: 0, processing: 0, oldestUploadAgeSeconds: 0 }
  assert.ok(
    assessMixed(good(), [
      { ...drained, queued: 1, oldestUploadAgeSeconds: 181 },
      drained,
    ]).reasons.includes('upload_queue_age'),
  )
  assert.ok(
    assessMixed(good(), [{ ...drained, queued: 1001 }, drained]).reasons.includes('upload_backlog'),
  )
  for (const value of [undefined, -1, NaN, Infinity]) {
    assert.ok(
      assessMixed(good(), [{ ...drained, oldestUploadAgeSeconds: value }]).reasons.includes(
        'missing_database_samples',
      ),
    )
  }
})

test('counter resets and non-advancing timestamps cannot imply CPU headroom', () => {
  const db = [1000, 6000, 11000].map((at) => ({
    at: new Date(at).toISOString(),
    connections: 20,
    queued: 0,
    processing: 0,
    oldestUploadAgeSeconds: 0,
  }))
  for (const mutate of [
    (r) => {
      r.samples[10].at = r.samples[9].at
    },
    (r) => {
      r.samples[10].cpu.user = 0
    },
    (r) => {
      r.samples[10].memory.rss = -1
    },
  ]) {
    const r = good()
    mutate(r)
    assert.ok(assessMixed(r, db).reasons.includes('missing_generator_samples'))
  }
})

test('a lone drained snapshot cannot certify the measurement window', () => {
  const row = { connections: 20, queued: 0, processing: 0, oldestUploadAgeSeconds: 0 }
  const samples = (times) => times.map((at) => ({ ...row, at: new Date(at).toISOString() }))
  for (const times of [[11000], [1001, 11000], [1000, 10999], [0, 11000], [1000, 1000, 11000]]) {
    assert.ok(assessMixed(good(), samples(times)).reasons.includes('database_sample_coverage'))
  }
  const db = samples([1000, 6000, 11000])
  assert.equal(assessMixed(good(), db).passed, true)
  const r = good()
  r.samples.forEach((x) => {
    x.at += 1
  })
  assert.ok(assessMixed(r, db).reasons.includes('generator_sample_coverage'))
  delete r.summary.measurementStartedAt
  assert.ok(assessMixed(r, db).reasons.includes('invalid_measurement_window'))
})

test('irregular sampling does not dilute a ten-second CPU spike over ten samples', () => {
  const r = good()
  r.summary.measurementStartedAt = new Date(0).toISOString()
  r.summary.measurementEndsAt = new Date(100000).toISOString()
  r.samples = Array.from({ length: 11 }, (_, i) => ({
    at: i * 10000,
    cpu: { user: i === 0 ? 0 : 10000000, system: 0 },
    memory: { rss: 100000 },
  }))
  const db = r.samples.map((x) => ({
    at: new Date(x.at).toISOString(),
    connections: 20,
    queued: 0,
    processing: 0,
    oldestUploadAgeSeconds: 0,
  }))
  assert.equal(generatorCpuWindows(r.samples)[0], 1)
  assert.ok(assessMixed(r, db).reasons.includes('generator_cpu'))
  const irregular = [0, 700, 1700, 2700, 4100, 5000, 6000, 7200, 8100, 9200, 10500, 11600].map(
    (at) => ({ at, cpu: { user: at * 500, system: 0 } }),
  )
  assert.deepEqual(generatorCpuWindows(irregular), [0.5, 0.5])
})
