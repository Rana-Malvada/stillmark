import { withServiceDatabase } from '../database/database-context'
import { createHash } from 'node:crypto'
import { pgQuery, pgTransaction, withAdvisoryLock } from '@/lib/postgres'
import { readAuth0LogPage } from '@/lib/identity/auth0-management'
import { querySnowflake } from '@/lib/snowflake'
import { HttpError } from '@/lib/http'

export type Provider = 'auth0' | 'snowflake'
export interface LoginEvent {
  id: string
  username: string
  at: string
  kind: 'login_success' | 'login_failure'
  provider: Provider
  code: string
  method: string
  scope: string
}
const success = new Set(['s', 'scoa', 'sens'])
const failure = new Set(['f', 'fc', 'fco', 'fcoa', 'fens', 'fp', 'fu'])
export function auth0Login(
  log: Record<string, unknown>,
  client: string,
  users: Map<string, string>,
): LoginEvent | null {
  if (
    !client ||
    log.client_id !== client ||
    typeof log.log_id !== 'string' ||
    !/^\d{1,100}$/.test(log.log_id)
  )
    return null
  const type = String(log.type)
  if (!success.has(type) && !failure.has(type)) return null
  const at = String(log.date)
  if (!Number.isFinite(Date.parse(at))) return null
  // An unresolved failure is NOT attributed to a person based on an attacker-supplied username.
  return {
    id: log.log_id,
    username: users.get(String(log.user_id)) ?? '[unmapped Auth0 identity]',
    at,
    kind: success.has(type) ? 'login_success' : 'login_failure',
    provider: 'auth0',
    code: type,
    method: 'auth0',
    scope: 'photo_app',
  }
}
export function snowflakeLogin(
  row: Record<string, unknown>,
  users: Set<string>,
): LoginEvent | null {
  const username = String(row.USER_NAME)
  if (
    !users.has(username) ||
    !/^\d+$/.test(String(row.EVENT_ID)) ||
    !['YES', 'NO'].includes(String(row.IS_SUCCESS))
  )
    return null
  const at = String(row.EVENT_TIMESTAMP)
  if (!Number.isFinite(Date.parse(at))) return null
  const method = String(row.FIRST_AUTHENTICATION_FACTOR ?? 'unknown')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 64)
  return {
    id: String(row.EVENT_ID),
    username,
    at,
    kind: row.IS_SUCCESS === 'YES' ? 'login_success' : 'login_failure',
    provider: 'snowflake',
    code: String(row.ERROR_CODE ?? '')
      .replace(/[^0-9]/g, '')
      .slice(0, 20),
    method,
    scope: 'account_not_app',
  }
}
export function identityEventId(provider: Provider, id: string) {
  const h = createHash('sha256').update(`${provider}:${id}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}
export async function storeLogin(event: LoginEvent) {
  const inserted = await pgQuery(
    `INSERT INTO user_activity_events(event_id,username,occurred_at,kind,target,source,details)
 SELECT $1,$2,$3::timestamptz,$4,'','server',$5::jsonb WHERE $3::timestamptz >= now()-interval '90 days' AND $3::timestamptz <= now()+interval '5 minutes'
 ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
    [
      identityEventId(event.provider, event.id),
      event.username,
      event.at,
      event.kind,
      JSON.stringify({
        provider: event.provider,
        code: event.code,
        method: event.method,
        scope: event.scope,
        outcome: event.kind === 'login_success' ? 'success' : 'failed',
      }),
    ],
  )
  return inserted.length
}
export async function identityStatus() {
  return pgQuery(
    'SELECT provider,attempted_at,completed_at,imported,scanned,error,more FROM identity_log_sync ORDER BY provider',
  )
}
async function syncIdentityService(provider: Provider) {
  const result = await withAdvisoryLock(`identity-import-${provider}`, async () => {
    const rows = await pgQuery<{ cursor: string | null; recent: boolean }>(
      "SELECT cursor,attempted_at>now()-interval '30 seconds' AS recent FROM identity_log_sync WHERE provider=$1",
      [provider],
    )
    if (rows[0]?.recent) throw new HttpError(429, 'Wait 30 seconds between imports')
    await pgQuery(
      `INSERT INTO identity_log_sync(provider,attempted_at) VALUES($1,now()) ON CONFLICT(provider) DO UPDATE SET attempted_at=now(),error=null`,
      [provider],
    )
    let imported = 0
    let scanned = 0
    let more = false
    try {
      const registry = await pgQuery<{ name: string; auth0_user_id: string | null }>(
        "SELECT name,auth0_user_id FROM gallery_access_objects WHERE kind='user'",
      )
      if (provider === 'auth0') {
        const client = process.env.AUTH0_GALLERY_CLIENT_ID
        if (!client || !/^[a-zA-Z0-9_-]{10,100}$/.test(client))
          throw new HttpError(503, 'Auth0 gallery client ID is not configured')
        const gatewayClient = process.env.AUTH0_GATEWAY_CLIENT_ID
        if (gatewayClient && !/^[a-zA-Z0-9_-]{10,100}$/.test(gatewayClient))
          throw new HttpError(503, 'Auth0 gateway client ID is not configured')
        const users = new Map(
          registry.filter((u) => u.auth0_user_id).map((u) => [u.auth0_user_id!, u.name]),
        )
        let cursor = rows[0]?.cursor ?? undefined
        // Bounded import: resume with the saved checkpoint on the next click.
        for (let page = 0; page < 4; page++) {
          const batch = await readAuth0LogPage(cursor)
          scanned += batch.logs.length
          if (!batch.logs.length) {
            more = false
            break
          }
          if (batch.cursor === cursor) throw new HttpError(502, 'Auth0 checkpoint did not advance')
          await pgTransaction(async () => {
            for (const log of batch.logs) {
              const event =
                auth0Login(log, client, users) ||
                (gatewayClient ? auth0Login(log, gatewayClient, users) : null)
              if (event) imported += await storeLogin(event)
            }
            await pgQuery('UPDATE identity_log_sync SET cursor=$2 WHERE provider=$1', [
              provider,
              batch.cursor,
            ])
          })
          cursor = batch.cursor ?? undefined
          more = true
        }
      } else {
        const users = new Set(registry.map((u) => u.name))
        if (users.size) {
          // Overlap handles delayed Account Usage delivery; deduplicate by provider event ID.
          const data = await querySnowflake(
            `SELECT EVENT_ID::VARCHAR AS EVENT_ID,TO_CHAR(EVENT_TIMESTAMP::TIMESTAMP_TZ,'YYYY-MM-DD"T"HH24:MI:SS.FF6TZH:TZM') AS EVENT_TIMESTAMP,USER_NAME,IS_SUCCESS,ERROR_CODE,FIRST_AUTHENTICATION_FACTOR
       FROM SNOWFLAKE.ACCOUNT_USAGE.LOGIN_HISTORY WHERE EVENT_TIMESTAMP >= DATEADD('day',-7,CURRENT_TIMESTAMP()) AND USER_NAME IN (${[...users].map(() => '?').join(',')})
       ORDER BY EVENT_TIMESTAMP DESC,EVENT_ID DESC LIMIT 10001`,
            { binds: [...users] },
          )
          if (data.length > 10000)
            throw new HttpError(
              409,
              'Snowflake login volume exceeds this import limit; no partial import was saved',
            )
          scanned = data.length
          await pgTransaction(async () => {
            for (const row of data) {
              const event = snowflakeLogin(row, users)
              if (event) imported += await storeLogin(event)
            }
          })
        }
      }
      await pgQuery(
        'UPDATE identity_log_sync SET completed_at=now(),imported=$2,scanned=$3,more=$4,error=null WHERE provider=$1',
        [provider, imported, scanned, more],
      )
      return { imported, scanned, more }
    } catch (error) {
      const message =
        error instanceof HttpError
          ? error.message
          : 'Import failed; check provider permissions and retry'
      await pgQuery('UPDATE identity_log_sync SET error=$2 WHERE provider=$1', [provider, message])
      throw new HttpError(error instanceof HttpError ? error.status : 502, message)
    }
  })
  if (result === null) throw new HttpError(409, 'An import is already running')
  return result
}

export function syncIdentity(...args: Parameters<typeof syncIdentityService>) {
  return withServiceDatabase(() => syncIdentityService(...args))
}
