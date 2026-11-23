import { pgQuery, pgQueryOne } from '../postgres'

/**
 * Display name and email of a gallery member, or null when the account has no access
 * record. Used for the account page while customer accounts are disabled.
 */
export function readMemberProfile(
  username: string,
): Promise<{ displayName: string; email: string } | null> {
  return pgQueryOne<{ displayName: string; email: string }>(
    `SELECT display_name AS "displayName",email FROM gallery_access_objects WHERE kind='user' AND name=$1`,
    [username],
  )
}

/** The signed-in customer's account details as assembled by the database, or null. */
export async function readCustomerAccount(): Promise<unknown> {
  const row = await pgQueryOne<{ account: unknown }>(
    'SELECT photo_security.customer_account_details() AS account',
  )
  return row?.account ?? null
}

/** Changes the signed-in customer's display name; the database identifies the caller. */
export async function updateCustomerProfile(displayName: string): Promise<void> {
  await pgQuery('SELECT photo_security.update_customer_profile($1)', [displayName])
}

/**
 * Requests deletion of the signed-in customer's account. The caller must already have
 * collected the typed confirmation.
 */
export async function requestAccountDeletion(): Promise<void> {
  await pgQuery('SELECT photo_security.request_account_deletion()')
}

/** Default allowances for new customers, or null. The caller must require an access manager. */
export async function readCustomerDefaultAllowances(): Promise<unknown> {
  const row = await pgQueryOne<{ settings: unknown }>(
    'SELECT photo_security.customer_default_allowances() AS settings',
  )
  return row?.settings ?? null
}

/** Sets the default allowances for new customers. The caller must require an access manager. */
export async function setCustomerDefaultAllowances(
  uploads: number,
  storageBytes: number,
): Promise<void> {
  await pgQuery('SELECT photo_security.set_customer_default_allowances($1,$2)', [
    uploads,
    storageBytes,
  ])
}

/** Sets one customer's allowances. The caller must require an access manager. */
export async function setCustomerAllowance(
  username: string,
  uploads: number,
  bytes: number,
  dailyAiSearches: number,
): Promise<void> {
  await pgQuery('SELECT photo_security.set_customer_allowance($1,$2,$3,$4)', [
    username,
    uploads,
    bytes,
    dailyAiSearches,
  ])
}

export interface PublicSignup {
  id: string
  created_at: Date | string
  display_name: string
}

/**
 * Recent public sign-ups for new-account notices. Run with the service database identity;
 * the database function decides how far back to look.
 */
export function listRecentPublicSignups(): Promise<PublicSignup[]> {
  return pgQuery<PublicSignup>(
    'SELECT id,created_at,display_name FROM photo_security.recent_public_signups()',
  )
}
