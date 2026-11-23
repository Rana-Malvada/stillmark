import { pgQueryOne } from '../postgres'
import { HttpError } from '../http'
import { flagOn } from '../flags'

/** In a publication transaction, holds the account fence until COMMIT/ROLLBACK.
 * Call before queue/session locks; outside a transaction this is only a fresh check. */
export async function requireUploadAccountAuthority(owner: string) {
  if (!flagOn('CUSTOMER_ACCOUNTS_ENABLED')) return
  const row = await pgQueryOne<{ allowed: boolean }>(
    'SELECT photo_security.upload_account_allowed($1) AS allowed',
    [owner],
  )
  if (row?.allowed !== true)
    throw new HttpError(403, 'Upload account is disabled or pending deletion')
}
