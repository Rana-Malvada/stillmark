import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EmailAlerts } from './alerts.mjs'
import {
  ALERT_DELAY_SECONDS,
  CHECK_INTERVAL_SECONDS,
  CHECKS_TO_ALERT,
  COORDINATOR_HEARTBEAT_SECONDS,
  evaluateWorkHealth,
  WORK_CODES,
  WORK_THRESHOLDS,
  workProblems,
  workSignals,
} from './work-health.mjs'

const idle = {
  oldestEligibleSeconds: null,
  activeLeases: 0,
  expiredLeases: 0,
  oldestExpiredLeaseSeconds: null,
  startingSeconds: null,
  workerSeenSeconds: null,
}
/** Every queue empty and the coordinator renewing: the state of an idle gallery. */
const quiet = () => ({
  coordinatorHeartbeatSeconds: 4,
  uploads: { ...idle },
  video: { ...idle },
  faces: { ...idle },
  ai: { ...idle, workerSeenSeconds: 86400 },
  search: { ...idle, activeLeases: null, expiredLeases: null },
})
const allHealthy = {
  coordinator: true,
  stalledUploads: true,
  stalledVideo: true,
  stalledFaces: true,
  stalledDescriptions: true,
  stalledSearch: true,
}

/**
 * Runs the real five-minute check against a monitor whose `workHealth` is a function of
 * the seconds elapsed since the scenario began, and records every email.
 */
async function monitorOver(checks, workHealth) {
  const state = new Map()
  const emails = []
  const results = []
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  const start = originalNow()
  let elapsed = 0
  Date.now = () => start + elapsed * 1000
  globalThis.fetch = async (url) =>
    new URL(url).pathname.endsWith('/live')
      ? Response.json({ status: 'ok' })
      : Response.json({
          database: true,
          databaseBytes: 1,
          failedUploadsLastHour: 0,
          ...workHealth(elapsed),
        })
  try {
    const monitor = new EmailAlerts(
      { storage: { get: async (k) => state.get(k), put: async (k, v) => state.set(k, v) } },
      {
        GATEWAY_SIGNING_KEY: 'ab'.repeat(32),
        SNOWFLAKE_ORIGIN: 'https://example.snowflakecomputing.app',
        PG_STORAGE_WARNING_BYTES: '8000000000',
        GATEWAY_TOKENS: {
          idFromName: () => 1,
          get: () => ({
            fetch: async (url) =>
              url.endsWith('/token')
                ? new Response('test')
                : Response.json({ expiresAt: Date.now() + 10 * 86400000 }),
          }),
        },
      },
    )
    monitor.deliver = async (subject, body) => {
      emails.push({ at: elapsed, subject, body })
      return { accepted: true }
    }
    for (let i = 0; i < checks; i++) {
      results.push(await monitor.check())
      elapsed += CHECK_INTERVAL_SECONDS
    }
  } finally {
    globalThis.fetch = originalFetch
    Date.now = originalNow
  }
  return { emails, results, state }
}

test('the alert interval is three five-minute checks', () => {
  assert.equal(CHECK_INTERVAL_SECONDS, 300)
  assert.equal(CHECKS_TO_ALERT, 3)
  assert.equal(ALERT_DELAY_SECONDS, 900)
})

test('an empty queue with a live coordinator stays healthy and sends nothing', async () => {
  const { emails, results } = await monitorOver(12, () => ({ workHealth: quiet() }))
  assert.deepEqual(emails, [])
  for (const result of results) assert.deepEqual({ ...allHealthy, ...result }, result)
  assert.equal(results[0].stalledUploads, true)
  assert.equal(results[0].coordinator, true)
})

test('pending uploads with a stopped worker alert within the stated interval, then recover', async () => {
  // An upload is queued at second 0 and the worker never claims it. It is fixed after
  // 50 minutes: the queue drains and stays empty.
  const fixedAt = 3000
  const { emails, results } = await monitorOver(14, (elapsed) => {
    const workHealth = quiet()
    if (elapsed < fixedAt) workHealth.uploads.oldestEligibleSeconds = elapsed
    return { workHealth }
  })
  const limit = WORK_THRESHOLDS.uploads.waitSeconds
  assert.equal(emails.length, 2)
  const [problem, recovery] = emails
  assert.equal(problem.subject, 'Needs attention: Stalled upload processing')
  // Not while the upload service could still be starting, and no later than the bound.
  assert.ok(problem.at > limit)
  assert.ok(problem.at <= limit + ALERT_DELAY_SECONDS)
  assert.equal(problem.at, 1800)
  assert.match(problem.body, /Oldest item ready to run has waited: 30 minutes/)
  assert.match(problem.body, /Items being processed now: 0/)
  // The unchanged incident is not mailed again on the following failing checks.
  assert.equal(results[7].stalledUploads, false)
  assert.equal(recovery.subject, 'Recovered: Stalled upload processing')
  assert.equal(recovery.at, fixedAt + CHECK_INTERVAL_SECONDS)
  assert.equal(results.at(-1).stalledUploads, true)
})

test('a stale coordinator heartbeat alerts on the third check and recovers after two', async () => {
  // The coordinator stops at second 0 and a new one takes over after 40 minutes.
  const { emails } = await monitorOver(12, (elapsed) => {
    const workHealth = quiet()
    if (elapsed < 2400) workHealth.coordinatorHeartbeatSeconds = elapsed
    return { workHealth }
  })
  assert.deepEqual(
    emails.map((e) => [e.at, e.subject]),
    [
      [900, 'Needs attention: Background coordinator'],
      [2700, 'Recovered: Background coordinator'],
    ],
  )
  assert.ok(emails[0].at <= COORDINATOR_HEARTBEAT_SECONDS + ALERT_DELAY_SECONDS)
  assert.match(emails[0].body, /Coordinator last renewed its lease: 15 minutes ago/)
})

test('a stopped worker and a stopped coordinator together raise both incidents', async () => {
  // Face scanning: the worker dies mid-run with two claims, and no coordinator settles it.
  const { emails } = await monitorOver(8, (elapsed) => {
    const workHealth = quiet()
    workHealth.coordinatorHeartbeatSeconds = elapsed
    workHealth.faces = {
      oldestEligibleSeconds: elapsed,
      activeLeases: elapsed < 300 ? 2 : 0,
      expiredLeases: elapsed < 300 ? 0 : 2,
      oldestExpiredLeaseSeconds: elapsed < 300 ? null : elapsed - 300,
      startingSeconds: null,
      workerSeenSeconds: elapsed,
    }
    return { workHealth }
  })
  assert.deepEqual(
    emails.map((e) => [e.at, e.subject]),
    [
      [900, 'Needs attention: Background coordinator'],
      // Silent for more than ten minutes at 15, 20 and 25 minutes.
      [1500, 'Needs attention: Stalled face scanning'],
    ],
  )
  assert.ok(
    emails[1].at <= WORK_THRESHOLDS.faces.silentSeconds + ALERT_DELAY_SECONDS,
    'within the silent allowance plus the alert delay',
  )
  assert.match(emails[1].body, /A running worker has stopped reporting in\./)
  assert.match(emails[1].body, /Abandoned claims: 2 \(oldest expired 20 minutes ago\)/)
})

test('email text contains only counts and ages', async () => {
  const { emails } = await monitorOver(8, (elapsed) => ({
    workHealth: {
      ...quiet(),
      coordinatorHeartbeatSeconds: elapsed,
      uploads: {
        ...idle,
        oldestEligibleSeconds: 5000 + elapsed,
        expiredLeases: 1000,
        oldestExpiredLeaseSeconds: 4000 + elapsed,
        // A value the gateway never renders, to prove unknown fields are not echoed.
        owner: 'someone@example.invalid',
        fileName: 'IMG_0001.jpg',
      },
    },
  }))
  assert.equal(emails.length, 2)
  for (const { body } of emails) {
    assert.doesNotMatch(body, /example\.invalid|IMG_0001|someone/)
    // Every line that carries a value carries only a number and a unit.
    for (const line of body.split('\n').filter((l) => /\d/.test(l) && !l.includes('https://')))
      assert.match(
        line,
        /^[A-Za-z .]+: (\d+|1000 or more)( (seconds|minutes))?( ago)?( \(oldest expired \d+ (seconds|minutes) ago\))?$|five minutes|three failed checks/,
      )
  }
  const uploads = emails.find((e) => e.subject.endsWith('Stalled upload processing'))
  assert.match(uploads.body, /Abandoned claims: 1000 or more \(oldest expired 76 minutes ago\)/)
})

test('normal behaviour is healthy: backoff, a busy worker, startup and hourly allowances', () => {
  const healthy = (kind, signals) =>
    assert.deepEqual(workProblems({ ...idle, ...signals }, WORK_THRESHOLDS[kind]), [], kind)
  // Work waiting only for its retry time is not eligible, so the monitor reports no age.
  healthy('uploads', { oldestEligibleSeconds: null })
  // A long queue that a worker is actively draining.
  healthy('uploads', { oldestEligibleSeconds: 7200, activeLeases: 2 })
  // The upload service is still resuming from its idle suspension.
  healthy('uploads', { oldestEligibleSeconds: WORK_THRESHOLDS.uploads.waitSeconds })
  // An expired claim that the worker has not yet taken over.
  healthy('uploads', { expiredLeases: 1, oldestExpiredLeaseSeconds: 300, activeLeases: 1 })
  for (const kind of ['video', 'faces', 'search']) {
    // A cold pool: launched twenty-five minutes ago, items queued behind it.
    healthy(kind, { oldestEligibleSeconds: 1500, startingSeconds: 1500 })
    // A large backfill: the oldest item has waited two hours while the worker reports in.
    healthy(kind, { oldestEligibleSeconds: 7200, workerSeenSeconds: 5 })
    // A warm, idle worker with nothing queued.
    healthy(kind, { workerSeenSeconds: 3 })
  }
  // The hourly description allowance is used up: nothing claimed for fifty minutes.
  healthy('ai', { oldestEligibleSeconds: 86400, workerSeenSeconds: 3000 })
  // Descriptions being generated now, in a deployment without admission records.
  healthy('ai', { oldestEligibleSeconds: 86400, activeLeases: 3 })
  // Nothing has been uploaded for a week.
  healthy('ai', { workerSeenSeconds: 604800 })
})

test('each stall rule trips just past its named threshold', () => {
  const problems = (kind, signals) => workProblems({ ...idle, ...signals }, WORK_THRESHOLDS[kind])
  assert.deepEqual(problems('uploads', { oldestEligibleSeconds: 901 }), ['wait'])
  assert.deepEqual(problems('uploads', { expiredLeases: 1, oldestExpiredLeaseSeconds: 601 }), [
    'lease',
  ])
  assert.deepEqual(problems('video', { startingSeconds: 2101, oldestEligibleSeconds: 2101 }), [
    'startup',
  ])
  assert.deepEqual(problems('faces', { workerSeenSeconds: 601 }), ['silent'])
  assert.deepEqual(problems('search', { workerSeenSeconds: 601 }), ['silent'])
  // The in-application video converter has no run and no heartbeat.
  assert.deepEqual(problems('video', { oldestEligibleSeconds: 1801 }), ['wait'])
  assert.deepEqual(problems('ai', { oldestEligibleSeconds: 4501, workerSeenSeconds: 4501 }), [
    'wait',
  ])
  assert.deepEqual(problems('ai', { expiredLeases: 2, oldestExpiredLeaseSeconds: 4501 }), ['lease'])
  // Search claims are not reported, so they can never trip the claim rule.
  assert.deepEqual(problems('search', { expiredLeases: 5, oldestExpiredLeaseSeconds: 99999 }), [])
})

test('missing or malformed signals are unknown: no incident opens and none recovers', async () => {
  assert.deepEqual(evaluateWorkHealth(undefined), { checks: {}, details: {} })
  assert.deepEqual(evaluateWorkHealth('stalled'), { checks: {}, details: {} })
  assert.equal(workSignals({ ...idle, activeLeases: -1 }), null)
  assert.equal(workSignals({ ...idle, oldestEligibleSeconds: '900' }), null)
  assert.equal(workSignals({ oldestEligibleSeconds: 1 }), null)
  // The coordinator has never run in this deployment: not a stall, and not a recovery.
  const partial = evaluateWorkHealth({ coordinatorHeartbeatSeconds: null, uploads: { ...idle } })
  assert.deepEqual(partial.checks, { [WORK_CODES.uploads]: true })

  // The stall opens an incident, then the application stops reporting the signals.
  const { emails, results, state } = await monitorOver(12, (elapsed) =>
    elapsed < 2100
      ? { workHealth: { ...quiet(), uploads: { ...idle, oldestEligibleSeconds: 2000 } } }
      : {},
  )
  assert.equal(emails.length, 1)
  assert.equal(emails[0].at, 600)
  assert.equal('stalledUploads' in results.at(-1), false)
  assert.equal(results.at(-1).database, true)
  assert.equal(state.get('stalledUploads').notified, true)
  assert.equal(state.get('stalledUploads').successes, 0)
})
