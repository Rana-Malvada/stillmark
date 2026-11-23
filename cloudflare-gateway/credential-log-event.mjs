/** @typedef {{ type?: unknown, date?: unknown, user_id?: unknown }} Auth0LogRow */

/**
 * Only successful changes revoke sessions; reset requests (scpr) do not.
 * @param {Auth0LogRow | null | undefined} row Parsed, untrusted log record.
 * @param {Env} env
 * @param {number} [now]
 * @returns {CredentialEvent | null}
 */
export function passwordChangeFromLog(row, env, now = Date.now()) {
  if (row?.type !== 'scp') return null
  const time = typeof row.date === 'string' ? Date.parse(row.date) : NaN
  if (
    !Number.isFinite(time) ||
    time < 1000 ||
    time > now + 5000 ||
    typeof row.user_id !== 'string' ||
    !row.user_id.startsWith('auth0|') ||
    row.user_id.length > 200
  )
    throw Error('Invalid password change')
  return {
    issuer: `https://${env.AUTH0_DOMAIN}/`,
    subject: row.user_id,
    changedAt: Math.floor(time / 1000),
  }
}
