import { pgQuery } from '@/lib/postgres'

export const OWNER = 'photo_security.username()'

/** Serialize an owner's short corrections before taking row locks. Names and the
 * latest-Undo chain are owner-wide invariants; different owners remain independent.
 * Never hold this lock across external work. */
export async function lockCorrections() {
  await pgQuery(
    `SELECT pg_advisory_xact_lock(hashtextextended('people-corrections:' || ${OWNER},0))`,
  )
}
