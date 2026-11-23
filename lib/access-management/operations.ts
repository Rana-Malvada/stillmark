// Own the durable journal, serialized request identity, replay and invalidation.
// Command implementations cannot mark an operation succeeded independently.
import { postgresPermissionsEnabled } from '../permission-authority'
import { HttpError } from '../http'
import { pgQuery, pgQueryOne, withAdvisoryLock } from '../postgres'
import type { AccessRequest } from './contracts'
import { executeAccessCommand } from './commands'
import { flagOn } from '../flags'

export async function runAccessOperation(actor: string, id: string, request: AccessRequest) {
  if (
    flagOn('CUSTOMER_ACCOUNTS_ENABLED') &&
    postgresPermissionsEnabled() &&
    ['createUser', 'createRole', 'setPassword', 'setupLink'].includes(request.action)
  )
    throw new HttpError(
      400,
      'Accounts use self-service signup and password recovery. Manage existing accounts here.',
    )
  // Credentials must never reach the durable operation journal or audit API.
  const journalRequest = 'password' in request ? { ...request, password: '[REDACTED]' } : request
  const result = await withAdvisoryLock('gallery-access-management', async () => {
    const previous = await pgQueryOne<{
      actor: string
      request: AccessRequest
      state: string
      result: unknown
    }>('SELECT * FROM gallery_access_operations WHERE id=$1', [id])
    if (
      previous &&
      (previous.actor !== actor ||
        Object.keys(previous.request).length !== Object.keys(journalRequest).length ||
        Object.keys(journalRequest).some(
          (k) =>
            (previous.request as Record<string, unknown>)[k] !==
            (journalRequest as Record<string, unknown>)[k],
        ))
    ) {
      throw new HttpError(409, 'Operation ID belongs to a different request')
    }
    if (previous?.state === 'succeeded') return previous.result
    await pgQuery(
      `INSERT INTO gallery_access_operations(id,actor,request,state) VALUES($1,$2,$3::jsonb,'running') ON CONFLICT(id) DO UPDATE SET state='running',error=NULL,updated_at=now()`,
      [id, actor, JSON.stringify(journalRequest)],
    )
    await pgQuery('SELECT photo_security.invalidate_authorization()')
    try {
      const response = await executeAccessCommand(actor, id, request, !!previous)
      // Never persist a password/reset URL. A replay tells the administrator to generate a new link.
      const stored =
        request.action === 'setupLink'
          ? {
              message:
                'This setup link was already generated. Generate a new link if you no longer have it.',
            }
          : response
      await pgQuery(
        "UPDATE gallery_access_operations SET state='succeeded',result=$2::jsonb,error=NULL,updated_at=now() WHERE id=$1",
        [id, JSON.stringify(stored)],
      )
      return response
    } catch (error) {
      const message =
        error instanceof HttpError
          ? error.message
          : 'Snowflake could not finish this operation. Check the account privileges and retry the same operation; completed steps will be retained.'
      await pgQuery(
        "UPDATE gallery_access_operations SET state='failed',error=$2,updated_at=now() WHERE id=$1",
        [id, message],
      )
      throw new HttpError(error instanceof HttpError ? error.status : 502, message)
    } finally {
      await pgQuery('SELECT photo_security.invalidate_authorization()')
    }
  })
  if (result === null)
    throw new HttpError(409, 'Another access change is running. Try again shortly')
  return result
}
