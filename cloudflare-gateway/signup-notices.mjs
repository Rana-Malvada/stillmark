/** One email per self-registered account, driven by the signed monitor response. */
const WINDOW = 72 * 3600000
// Each send may take up to 25 seconds; later accounts wait for the next five-minute check.
export const SIGNUP_NOTICES_PER_CHECK = 3
/**
 * @typedef {{ id: string, createdAt: number, displayName: string }} SignupRecord
 * @typedef {{ since: number, seen: Record<string, number> }} SignupState
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Accept only well-formed records; the display name is member-supplied text.
 * @param {unknown} value
 * @returns {SignupRecord[] | null}
 */
export function signupRecords(value) {
  if (!Array.isArray(value)) return null
  /** @type {SignupRecord[]} */
  const records = []
  for (const item of value.slice(0, 200)) {
    if (
      !record(item) ||
      typeof item.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.id) ||
      typeof item.createdAt !== 'string' ||
      typeof item.displayName !== 'string'
    )
      continue
    const createdAt = Date.parse(item.createdAt)
    if (!Number.isFinite(createdAt)) continue
    records.push({
      id: item.id,
      createdAt,
      displayName:
        item.displayName.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) ||
        'Member',
    })
  }
  return records.sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Accounts created before notifications were first observed are never reported.
 * `seen` holds reported markers until they have left the monitor's 48-hour window.
 * @param {unknown} previous Stored state, if any.
 * @param {SignupRecord[] | null} records
 * @param {number} now
 */
export function signupPlan(previous, records, now) {
  /** @type {SignupState} */
  const state = record(previous)
    ? { since: Number(previous.since), seen: { ...previous.seen } }
    : { since: now, seen: {} }
  if (!Number.isFinite(state.since)) state.since = now
  for (const [id, at] of Object.entries(state.seen)) if (!(now - at < WINDOW)) delete state.seen[id]
  const due = (records ?? []).filter(
    (r) => r.createdAt > state.since && now - r.createdAt < WINDOW && !(r.id in state.seen),
  )
  return { state, due: due.slice(0, SIGNUP_NOTICES_PER_CHECK) }
}

/**
 * @param {SignupRecord} signup
 * @param {string} origin
 */
export function signupMessage(signup, origin) {
  return {
    subject: 'New account created',
    body: `A new Stillmark account was created.\n\nDisplay name: ${signup.displayName}\nCreated: ${new Date(signup.createdAt).toUTCString()}\n\nOpen ${origin}/ and choose Admin to review accounts.\nThis notice is sent once for each new account.`,
  }
}

/**
 * Sends due notices in order and stops at the first failure so it is retried next check.
 * @param {Pick<DurableObjectStorage, 'get' | 'put'>} storage
 * @param {unknown} value The monitor's `recentSignups`.
 * @param {number} now
 * @param {string} origin
 * @param {(subject: string, body: string) => Promise<AlertDelivery>} deliver
 */
export async function notifySignups(storage, value, now, origin, deliver) {
  const records = signupRecords(value)
  const { state, due } = signupPlan(await storage.get('signups'), records, now)
  let sent = 0
  for (const signup of due) {
    const { subject, body } = signupMessage(signup, origin)
    let accepted = false
    try {
      accepted = (await deliver(subject, body))?.accepted === true
    } catch {}
    try {
      console.info(JSON.stringify({ event: 'stillmark_signup_notice', version: 1, accepted }))
    } catch {
      // Telemetry must not change delivery state.
    }
    if (!accepted) break
    state.seen[signup.id] = signup.createdAt
    sent++
    // Persist each acceptance so a later failure cannot cause a repeat.
    await storage.put('signups', state)
  }
  await storage.put('signups', state)
  return sent
}
