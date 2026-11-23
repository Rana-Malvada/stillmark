/**
 * Stalled background work, judged from the signed monitor's `workHealth` numbers.
 *
 * The existing failure check counts work that ended in failure. Work that never ends
 * (a queue nobody is claiming, a claim whose worker died, a worker that never started,
 * a coordinator that stopped scheduling) fails nothing, so it is judged here instead.
 * Every rule needs evidence of a stall, never just a long queue: an empty queue, work
 * waiting for a retry time, a busy worker and a pool that is still starting are healthy.
 */

/**
 * @typedef {'uploads' | 'video' | 'faces' | 'ai' | 'search'} WorkKind
 * @typedef {'wait' | 'lease' | 'startup' | 'silent'} WorkProblem
 * @typedef {{
 *   oldestEligibleSeconds: number | null, activeLeases: number | null,
 *   expiredLeases: number | null, oldestExpiredLeaseSeconds: number | null,
 *   startingSeconds: number | null, workerSeenSeconds: number | null,
 * }} WorkSignals
 * @typedef {{
 *   waitSeconds: number, leaseSeconds: number | null,
 *   startupSeconds: number | null, silentSeconds: number | null,
 * }} WorkThresholds
 */

/** The scheduled check runs every five minutes. */
export const CHECK_INTERVAL_SECONDS = 300
/** An incident opens on the third consecutive failing check (see `transition`). */
export const CHECKS_TO_ALERT = 3
/**
 * Longest time from a signal passing its threshold to the problem email being sent:
 * up to one interval until the first failing check, then two more checks.
 */
export const ALERT_DELAY_SECONDS = CHECKS_TO_ALERT * CHECK_INTERVAL_SECONDS

/**
 * The coordinator renews its lease every ten seconds. A restart or a change of
 * coordinator leaves a gap of under a minute; three minutes is not a restart.
 */
export const COORDINATOR_HEARTBEAT_SECONDS = 180

/**
 * Allowances per kind of work, in seconds. `null` turns a rule off for that kind.
 *
 * - `waitSeconds`: how long a runnable item may wait while nothing is being processed.
 * - `leaseSeconds`: how long an expired claim may stay unreclaimed.
 * - `startupSeconds`: how long a launched worker run may take to report in.
 * - `silentSeconds`: how long a running worker run may go without a heartbeat.
 *
 * @type {Record<WorkKind, WorkThresholds>}
 */
export const WORK_THRESHOLDS = {
  // The upload service suspends when idle and takes several minutes to resume, and a
  // retry backs off for at most five minutes. A live worker reclaims an expired
  // five-minute claim on its next poll, a few seconds later.
  uploads: { waitSeconds: 900, leaseSeconds: 600, startupSeconds: null, silentSeconds: null },
  // GPU playback and face jobs start from a cold pool. The application stops a run that
  // has not started within thirty minutes and settles one whose three-minute heartbeat
  // limit has passed, so these only trip when that recovery is not happening either.
  video: { waitSeconds: 1800, leaseSeconds: 900, startupSeconds: 2100, silentSeconds: 600 },
  faces: { waitSeconds: 1800, leaseSeconds: 900, startupSeconds: 2100, silentSeconds: 600 },
  // Descriptions are admitted per clock hour: once an hourly allowance is used, runnable
  // photos and expired fifteen-minute claims wait for the next hour by design.
  ai: { waitSeconds: 4500, leaseSeconds: 4500, startupSeconds: null, silentSeconds: null },
  // The search worker heartbeats every five seconds, also while warm and idle; the
  // application settles a run after two minutes without one. Claims are not reported.
  search: { waitSeconds: 1800, leaseSeconds: null, startupSeconds: 2100, silentSeconds: 600 },
}

/** Incident codes, which are also the Durable Object storage keys. */
export const COORDINATOR_CODE = 'coordinator'
/** @type {Record<WorkKind, string>} */
export const WORK_CODES = {
  uploads: 'stalledUploads',
  video: 'stalledVideo',
  faces: 'stalledFaces',
  ai: 'stalledDescriptions',
  search: 'stalledSearch',
}
/** @type {Record<string, string>} */
export const workLabels = {
  [COORDINATOR_CODE]: 'Background coordinator',
  [WORK_CODES.uploads]: 'Stalled upload processing',
  [WORK_CODES.video]: 'Stalled video preparation',
  [WORK_CODES.faces]: 'Stalled face scanning',
  [WORK_CODES.ai]: 'Stalled photo descriptions',
  [WORK_CODES.search]: 'Stalled search enrichment',
}
export const workCodes = Object.keys(workLabels)

const FIELDS = /** @type {const} */ ([
  'oldestEligibleSeconds',
  'activeLeases',
  'expiredLeases',
  'oldestExpiredLeaseSeconds',
  'startingSeconds',
  'workerSeenSeconds',
])

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
/**
 * @param {unknown} value
 * @returns {value is number | null}
 */
const measure = (value) =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)

/**
 * Accept only a complete set of non-negative numbers; anything else is unknown.
 * @param {unknown} value
 * @returns {WorkSignals | null}
 */
export function workSignals(value) {
  if (!record(value)) return null
  /** @type {Record<string, number | null>} */
  const signals = {}
  for (const field of FIELDS) {
    const item = Object.hasOwn(value, field) ? value[field] : undefined
    if (!measure(item)) return null
    signals[field] = item
  }
  return /** @type {WorkSignals} */ (signals)
}

/**
 * Which stall rules a kind of work currently breaks; an empty list is healthy.
 * @param {WorkSignals} s
 * @param {WorkThresholds} t
 * @returns {WorkProblem[]}
 */
export function workProblems(s, t) {
  /** @type {WorkProblem[]} */
  const problems = []
  // Runnable work has waited too long and nothing shows a worker handling the queue:
  // no live claim, no run still inside its startup allowance, no recent sign of life.
  if (
    s.oldestEligibleSeconds !== null &&
    s.oldestEligibleSeconds > t.waitSeconds &&
    !s.activeLeases &&
    s.startingSeconds === null &&
    (s.workerSeenSeconds === null || s.workerSeenSeconds > t.waitSeconds)
  )
    problems.push('wait')
  if (
    t.leaseSeconds !== null &&
    !!s.expiredLeases &&
    s.oldestExpiredLeaseSeconds !== null &&
    s.oldestExpiredLeaseSeconds > t.leaseSeconds
  )
    problems.push('lease')
  if (
    t.startupSeconds !== null &&
    s.startingSeconds !== null &&
    s.startingSeconds > t.startupSeconds
  )
    problems.push('startup')
  if (
    t.silentSeconds !== null &&
    s.startingSeconds === null &&
    s.workerSeenSeconds !== null &&
    s.workerSeenSeconds > t.silentSeconds
  )
    problems.push('silent')
  return problems
}

/** @param {number} seconds */
const duration = (seconds) =>
  seconds < 120 ? `${Math.floor(seconds)} seconds` : `${Math.floor(seconds / 60)} minutes`
/** The application stops counting at 1000. @param {number} count */
const tally = (count) => (count >= 1000 ? '1000 or more' : String(count))

/**
 * Counts and ages only: the monitor sends nothing else, and nothing else is written.
 * @param {WorkSignals} s
 * @param {WorkProblem[]} problems
 */
export function workDetail(s, problems) {
  /** @type {Record<WorkProblem, string>} */
  const reasons = {
    wait: 'Work that is ready to run is not being picked up.',
    lease:
      'Work was claimed by a worker that stopped before finishing it, and it has not been taken over.',
    startup: 'A worker was launched but has not started.',
    silent: 'A running worker has stopped reporting in.',
  }
  const lines = problems.map((problem) => reasons[problem])
  if (s.oldestEligibleSeconds !== null)
    lines.push(`Oldest item ready to run has waited: ${duration(s.oldestEligibleSeconds)}`)
  if (s.activeLeases !== null) lines.push(`Items being processed now: ${tally(s.activeLeases)}`)
  if (s.expiredLeases !== null)
    lines.push(
      `Abandoned claims: ${tally(s.expiredLeases)}` +
        (s.oldestExpiredLeaseSeconds !== null
          ? ` (oldest expired ${duration(s.oldestExpiredLeaseSeconds)} ago)`
          : ''),
    )
  if (s.startingSeconds !== null)
    lines.push(`Worker has been starting for: ${duration(s.startingSeconds)}`)
  if (s.workerSeenSeconds !== null)
    lines.push(`Worker last reported in: ${duration(s.workerSeenSeconds)} ago`)
  lines.push('Review Admin Processing and the worker services.')
  return lines.join('\n')
}

/**
 * Turns the monitor's `workHealth` into incident checks. A missing or malformed signal
 * produces no entry, so it stays unknown: it neither opens nor recovers an incident.
 * @param {unknown} value
 * @returns {{ checks: Record<string, boolean>, details: Record<string, string> }}
 */
export function evaluateWorkHealth(value) {
  /** @type {Record<string, boolean>} */
  const checks = {}
  /** @type {Record<string, string>} */
  const details = {}
  if (!record(value)) return { checks, details }
  const heartbeat = Object.hasOwn(value, 'coordinatorHeartbeatSeconds')
    ? value.coordinatorHeartbeatSeconds
    : undefined
  // null means the coordinator has never run here, which is not a stall.
  if (typeof heartbeat === 'number' && measure(heartbeat)) {
    checks[COORDINATOR_CODE] = heartbeat <= COORDINATOR_HEARTBEAT_SECONDS
    if (!checks[COORDINATOR_CODE])
      details[COORDINATOR_CODE] =
        `The background coordinator has stopped scheduling work. No queued upload, description, face, video or search work is started or recovered until it resumes.\nCoordinator last renewed its lease: ${duration(heartbeat)} ago\nCheck that the web application is running with background jobs enabled.`
  }
  for (const kind of /** @type {WorkKind[]} */ (Object.keys(WORK_THRESHOLDS))) {
    const signals = workSignals(Object.hasOwn(value, kind) ? value[kind] : undefined)
    if (!signals) continue
    const problems = workProblems(signals, WORK_THRESHOLDS[kind])
    checks[WORK_CODES[kind]] = problems.length === 0
    if (problems.length) details[WORK_CODES[kind]] = workDetail(signals, problems)
  }
  return { checks, details }
}
