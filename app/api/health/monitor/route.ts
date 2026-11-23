import { withDatabaseRequest, withServiceDatabase } from '@/lib/database/database-context'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { getSecret, SecretType } from '@/lib/snowflake'
import { listRecentPublicSignups } from '@/lib/identity/account-customer'
import { readDatabaseHealth, readWorkHealth } from '@/lib/database/postgres-health'
import { deployment } from '@/config/deployment.mjs'
import { flagOn } from '@/lib/flags'

export const dynamic = 'force-dynamic'
async function GETHandler(request: Request) {
  const stamp = request.headers.get('x-photo-monitor-time') ?? ''
  const signature = request.headers.get('x-photo-monitor-signature') ?? ''
  if (
    request.headers.get('sf-context-current-user') !== deployment.GATEWAY_USER ||
    !/^\d{13}$/.test(stamp) ||
    Math.abs(Date.now() - Number(stamp)) > 30000 ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return new Response('Unauthorized', { status: 401 })
  const expected = createHmac(
    'sha256',
    Buffer.from(getSecret('GATEWAY_SIGNING', SecretType.GENERIC_STRING), 'hex'),
  )
    .update('photo-monitor-v1:' + stamp)
    .digest()
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
    return new Response('Unauthorized', { status: 401 })
  try {
    const row = await withServiceDatabase(() => readDatabaseHealth())
    if (!row) throw Error('No result')
    return Response.json(
      {
        database: true,
        databaseBytes: Number(row.bytes),
        failedUploadsLastHour: row.failed,
        ...(await workHealth()),
        ...(await recentSignups()),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch {
    return Response.json({ database: false }, { headers: { 'Cache-Control': 'no-store' } })
  }
}

/**
 * Stall signals for queued background work: counts and ages only. A failure or a slow
 * read here must never report the database as unhealthy; the signals are left out and
 * the gateway treats them as unknown.
 */
async function workHealth() {
  try {
    const health = await withServiceDatabase(
      () => readWorkHealth({ appConvertsVideo: flagOn('VIDEO_CONVERSION_ENABLED') }),
      AbortSignal.timeout(6000),
    )
    return health ? { workHealth: health } : {}
  } catch {
    return {}
  }
}

/** New-account notices only. A failure here must never report the database as unhealthy. */
async function recentSignups() {
  if (!flagOn('CUSTOMER_ACCOUNTS_ENABLED')) return {}
  try {
    const rows = await withServiceDatabase(() => listRecentPublicSignups())
    return {
      recentSignups: rows.map((row) => ({
        id: row.id,
        createdAt: new Date(row.created_at).toISOString(),
        displayName: row.display_name,
      })),
    }
  } catch {
    return {}
  }
}

export const GET = withDatabaseRequest(GETHandler)
