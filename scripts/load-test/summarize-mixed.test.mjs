import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeMixed } from './summarize-mixed.mjs'

const db = Array.from({ length: 13 }, (_, i) => ({
  at: new Date(i * 10000).toISOString(),
  connections: 30,
  queued: 0,
  processing: 0,
  oldestUploadAgeSeconds: 0,
}))
function result() {
  return {
    wallMs: 150000,
    summary: {
      passed: true,
      capacityEligible: true,
      measurementStartedAt: new Date(0).toISOString(),
      measurementEndsAt: new Date(120000).toISOString(),
      uploadCoveredMeasurement: true,
      completed: 4,
      measuredRequests: 2400,
      measurementSeconds: 120,
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
        ].map((k) => [
          'measured:' + k,
          {
            count: 30,
            errors: 0,
            endToEnd: { p95Ms: 100, p99Ms: 150 },
            generatorWait: { p95Ms: 0 },
          },
        ]),
      ),
    },
    samples: Array.from({ length: 121 }, (_, i) => ({
      at: i * 1000,
      cpu: { user: i * 10000, system: 0 },
      memory: { rss: 10000000 },
    })),
  }
}
test('a successful HTTP run cannot hide missing or duplicate publications', () => {
  const durable = { jobs: 4, done: 4, distinctUploads: 4, photos: 4, aiRestRequests: 0 }
  assert.equal(summarizeMixed(result(), db, durable).passed, true)
  assert.equal(summarizeMixed(result(), db, { ...durable, photos: 5 }).passed, false)
  assert.equal(summarizeMixed(result(), db, { ...durable, done: 3 }).passed, false)
  assert.equal(summarizeMixed(result(), db, { ...durable, aiRestRequests: 1 }).passed, false)
  assert.equal(summarizeMixed(result(), db, durable).measuredRequestsPerSecond, 20)
})

test('an aborted window is not reported as sustained throughput', () => {
  const r = result()
  r.summary.passed = false
  r.summary.capacityEligible = false
  assert.equal(
    summarizeMixed(r, db, { jobs: 4, done: 4, distinctUploads: 4, photos: 4, aiRestRequests: 0 })
      .measuredRequestsPerSecond,
    null,
  )
})

test('reported CPU uses the same timestamp-based windows as the gate', () => {
  const r = result()
  r.samples = Array.from({ length: 13 }, (_, i) => ({
    at: i * 10000,
    cpu: { user: i === 0 ? 0 : 10000000, system: 0 },
    memory: { rss: 1000000 },
  }))
  const report = summarizeMixed(r, db, {
    jobs: 4,
    done: 4,
    distinctUploads: 4,
    photos: 4,
    aiRestRequests: 0,
  })
  assert.equal(report.maxGeneratorCpuFraction, 1)
  assert.ok(report.reasons.includes('generator_cpu'))
})
