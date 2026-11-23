import pg from 'pg'
import type { DatabaseIdentity } from './database-context'

function literal(value: string): string {
  if (value.includes('\0')) throw new Error('Invalid database identity')
  return pg.escapeLiteral(value)
}

/** BEGIN and transaction-local identity share one protocol round trip. Query
 * parameters remain bound separately. Never interpolate SQL supplied by callers. */
export function requestTransactionStart(
  identity: DatabaseIdentity | null,
  publicHash = '',
): string {
  const settings = [
    ['photos.username', identity?.username ?? ''],
    ['photos.main_admin', identity?.mainAdmin ? 'true' : 'false'],
    ['photos.admin_read', identity?.adminRead ? 'true' : 'false'],
    ['photos.admin_write', identity?.adminWrite ? 'true' : 'false'],
    ['photos.can_write', identity?.canWrite ? 'true' : 'false'],
    ['photos.access_manager', identity?.accessManager ? 'true' : 'false'],
    ['photos.public_hash', publicHash],
  ]
  return (
    'BEGIN; SELECT ' +
    settings.map(([name, value]) => `set_config('${name}',${literal(value)},true)`).join(',')
  )
}

export function readTransactionStart(
  identity: { username: string; mainAdmin: boolean },
  disableJit = false,
): string {
  return (
    'BEGIN READ ONLY; SET LOCAL ROLE personal_photos_reader' +
    (disableJit ? '; SET LOCAL jit=off' : '') +
    `; SELECT set_config('photos.username',${literal(identity.username)},true),` +
    `set_config('photos.main_admin','${identity.mainAdmin ? 'true' : 'false'}',true)`
  )
}
