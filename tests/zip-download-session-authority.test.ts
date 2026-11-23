// A signed-in ZIP download is authenticated once, by a gateway assertion that is valid for
// seconds and usable a single time. The archive can take much longer, so before each
// file the route reads again, from the database, what that session may do now.
//
// Each case starts a real download of files A, B and C as it runs in production: through
// the sign-in gateway (a signed, request-bound assertion), with permissions held in
// PostgreSQL and customer accounts on. It holds A's original open in storage, changes
// the account or the session while A is still streaming, lets A finish and reads the
// bytes the client received.
//
// The real route handler, authentication, authorization, database layer and row-level
// security run (see fixtures/route-database). Only storage is replaced, and the signing
// key the platform would supply.
import { APP_ORIGIN, createRouteDatabase, DATABASE_ENV } from './fixtures/route-database'
import type { PGlite } from '@electric-sql/pglite'
import { createHmac, randomUUID } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const SIGNING_KEY = 'ab'.repeat(32)
const s = vi.hoisted(() => ({ db: null as unknown as PGlite, headers: new Headers() }))
vi.mock('pg', async () =>
  (await import('./fixtures/route-database')).pgliteDriver(
    await vi.importActual<typeof import('pg')>('pg'),
    () => s.db,
  ),
)
vi.mock('next/headers', () => ({ headers: async () => s.headers }))
vi.mock('@/lib/snowflake', () => ({
  getServiceToken: () => 'platform-session',
  getSecret: () => SIGNING_KEY,
  SecretType: { GENERIC_STRING: 'GENERIC_STRING' },
  querySnowflake: async () => {
    throw new Error('Permissions are held in PostgreSQL; the role provider is never asked')
  },
  querySnowflakeStorage: async () => {
    throw new Error('Storage is reached only through the signed URLs replaced below')
  },
}))
vi.mock('@/lib/media/image-urls', () => ({
  getPresignedUrl: async (path: string) => `https://storage.invalid/${path}`,
  invalidateMediaUrl: () => {},
}))
import { GET as memberZip } from '@/app/api/photos/download/route'
import { closePool } from '@/lib/postgres'

const TARGET = '/api/photos/download?ids=1,2,3'
const BOB = {
  subject: 'auth0|bob',
  marker: '22222222-2222-4222-8222-222222222222',
  sid: 'b0b00000-0000-4000-8000-000000000001',
}
const OWNER = {
  subject: 'auth0|owner',
  marker: '33333333-3333-4333-8333-333333333333',
  sid: '0e000000-0000-4000-8000-000000000001',
}
const SESSION_STARTED = Math.floor(Date.now() / 1000) - 600

/** A request from the gateway on behalf of one signed-in session, as it arrives. */
function signIn(
  who: { subject: string; sid: string },
  startedAt: number | undefined = SESSION_STARTED,
) {
  const now = Math.floor(Date.now() / 1000)
  const body = Buffer.from(
    JSON.stringify({
      jti: randomUUID(),
      method: 'GET',
      target: TARGET,
      sub: who.subject,
      sid: who.sid,
      startedAt,
      aud: APP_ORIGIN,
      iat: now,
      exp: now + 30,
    }),
  ).toString('base64url')
  const signature = createHmac('sha256', Buffer.from(SIGNING_KEY, 'hex'))
    .update(body)
    .digest('base64url')
  s.headers = new Headers({
    origin: APP_ORIGIN,
    host: new URL(APP_ORIGIN).host,
    'sf-context-current-user': 'PERSONAL_PHOTOS_GATEWAY',
    'sf-context-current-user-token': 'gateway-service-token',
    'x-photo-request-method': 'GET',
    'x-photo-request-target': TARGET,
    'x-photo-gateway-identity': `${body}.${signature}`,
  })
}

const A = 'bytes-of-original-A:'.repeat(64)
const B = 'bytes-of-original-B:'.repeat(64)
const C = 'bytes-of-original-C:'.repeat(64)
const ORIGINALS: Record<string, string> = {
  'originals/a.jpg': A,
  'originals/b.jpg': B,
  'originals/c.jpg': C,
}
/** Storage paths requested so far, in order. */
let opened: string[] = []
/** Lets the held original of A finish. */
let finishA: () => void = () => {}
/** SQL to run when storage is asked for a path, before storage answers. */
let whileStorageAnswers: Record<string, string> = {}

beforeAll(async () => {
  for (const [name, value] of Object.entries(DATABASE_ENV)) vi.stubEnv(name, value)
  vi.stubEnv('GATEWAY_AUTH_ENABLED', 'true')
  vi.stubEnv('GATEWAY_ORIGIN', APP_ORIGIN)
  vi.stubEnv('APP_PERMISSION_AUTHORITY', 'postgres')
  vi.stubEnv('CUSTOMER_ACCOUNTS_ENABLED', 'true')
  s.db = await createRouteDatabase()
}, 60_000)
afterAll(async () => {
  await closePool()
  await s.db?.close()
  vi.unstubAllEnvs()
})
beforeEach(async () => {
  opened = []
  whileStorageAnswers = {}
  // Album 1 is Alice's, private and shared with Bob, a member. Owner is the application
  // owner and main administrator, who can read it without a share.
  await s.db
    .exec(`DELETE FROM album_shares;DELETE FROM photo_trash;DELETE FROM photos;DELETE FROM events;
 DELETE FROM gallery_revoked_sessions;DELETE FROM photo_security.credential_cutoffs;
 DELETE FROM photo_security.gateway_assertions;DELETE FROM gallery_main_admins;
 DELETE FROM gallery_access_objects;
 INSERT INTO gallery_main_admins(username) VALUES('OWNER');
 INSERT INTO gallery_access_objects(kind,name,marker,display_name,created_by,state,auth0_user_id) VALUES
  ('user','ALICE','11111111-1111-4111-8111-111111111111','Alice','OWNER','ready','auth0|alice'),
  ('user','BOB','${BOB.marker}','Bob','OWNER','ready','${BOB.subject}'),
  ('user','OWNER','${OWNER.marker}','Owner','OWNER','ready','${OWNER.subject}');
 INSERT INTO photo_security.app_principals(marker) VALUES('${BOB.marker}'),('${OWNER.marker}');
 INSERT INTO photo_security.app_memberships(marker,role_key) VALUES
  ('${BOB.marker}','viewer'),('${OWNER.marker}','app_owner');
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES
  (1,1,'Shared trip','alice','ALICE','PRIVATE');
 INSERT INTO album_shares(event_id,username,created_by) VALUES(1,'BOB','ALICE');
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path,display_stage_path,thumbnail_stage_path) VALUES
  (1,1,'a.jpg','photo','READY','originals/a.jpg','display/a.jpg','thumbnails/a.jpg'),
  (2,1,'b.jpg','photo','READY','originals/b.jpg','display/b.jpg','thumbnails/b.jpg'),
  (3,1,'c.jpg','photo','READY','originals/c.jpg','display/c.jpg','thumbnails/c.jpg');`)
  // Storage: A sends its first half and stays open until the test releases it; the other
  // originals are returned whole.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname.slice(1)
      opened.push(path)
      if (whileStorageAnswers[path]) await s.db.exec(whileStorageAnswers[path])
      const bytes = Buffer.from(ORIGINALS[path])
      if (path !== 'originals/a.jpg') return new Response(bytes)
      const half = bytes.length / 2
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.subarray(0, half))
            finishA = () => {
              controller.enqueue(bytes.subarray(half))
              controller.close()
            }
          },
        }),
      )
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

/** A new request with a new assertion, as each browser request gets. */
function start(who: { subject: string; sid: string }, startedAt?: number) {
  signIn(who, startedAt)
  return memberZip(new Request(APP_ORIGIN + TARGET))
}

/**
 * Changes the database while A is still streaming, then reads everything the client
 * receives. `failed` is true when the transfer was cut off instead of completing.
 */
async function changeWhileStreaming(response: Response, change: string) {
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const chunks: Uint8Array[] = []
  // The archive has begun and A's original is open; nothing else has been requested.
  const first = await reader.read()
  expect(first.done).toBe(false)
  chunks.push(first.value!)
  expect(opened).toEqual(['originals/a.jpg'])
  await s.db.exec(change)
  finishA()
  let failed = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(next.value)
    }
  } catch {
    failed = true
  }
  const received = Buffer.concat(chunks)
  return { received, failed, files: () => unzipSync(received) }
}
/** The transfer was cut off: no bytes of B or C were sent and neither was requested. */
function expectStopped(result: Awaited<ReturnType<typeof changeWhileStreaming>>) {
  expect(result.failed).toBe(true)
  expect(result.received.includes(Buffer.from('bytes-of-original-B'))).toBe(false)
  expect(result.received.includes(Buffer.from('bytes-of-original-C'))).toBe(false)
  expect(opened).toEqual(['originals/a.jpg'])
}

const DISABLE_BOB = `UPDATE photo_security.app_principals SET enabled=false WHERE marker='${BOB.marker}'`
const LOG_BOB_OUT = `SELECT photo_security.revoke_session('${BOB.sid}')`
const WITHDRAW_BOBS_ROLE = `DELETE FROM photo_security.app_memberships WHERE marker='${BOB.marker}'`

describe('signed-in ZIP through the gateway', () => {
  it('contains every file when nothing changes during the transfer', async () => {
    const result = await changeWhileStreaming(await start(BOB), 'SELECT 1')
    expect(result.failed).toBe(false)
    const files = result.files()
    expect(Object.keys(files)).toEqual(['1-a.jpg', '2-b.jpg', '3-c.jpg'])
    expect(strFromU8(files['2-b.jpg'])).toBe(B)
    expect(strFromU8(files['3-c.jpg'])).toBe(C)
    expect(opened).toEqual(['originals/a.jpg', 'originals/b.jpg', 'originals/c.jpg'])
  })

  it('consumes the assertion once however many files are re-authorized', async () => {
    await changeWhileStreaming(await start(BOB), 'SELECT 1')
    const claimed = await s.db.query('SELECT jti FROM photo_security.gateway_assertions')
    expect(claimed.rows).toHaveLength(1)
  })

  it('stops when the account is disabled while an earlier file streams', async () => {
    expectStopped(await changeWhileStreaming(await start(BOB), DISABLE_BOB))
    expect((await start(BOB)).status).toBe(403)
  })

  it('stops when the session is logged out while an earlier file streams', async () => {
    expectStopped(await changeWhileStreaming(await start(BOB), LOG_BOB_OUT))
    expect((await start(BOB)).status).toBe(401)
  })

  it('stops when the role is withdrawn while an earlier file streams', async () => {
    expectStopped(await changeWhileStreaming(await start(BOB), WITHDRAW_BOBS_ROLE))
    expect((await start(BOB)).status).toBe(403)
  })

  it('stops when the credentials change after the session began', async () => {
    expectStopped(
      await changeWhileStreaming(
        await start(BOB),
        `INSERT INTO photo_security.credential_cutoffs(subject,cutoff)
         VALUES('${BOB.subject}',${SESSION_STARTED + 60})`,
      ),
    )
    expect((await start(BOB)).status).toBe(401)
  })

  it('continues for a session that began after the credential change', async () => {
    const result = await changeWhileStreaming(
      await start(BOB),
      `INSERT INTO photo_security.credential_cutoffs(subject,cutoff)
       VALUES('${BOB.subject}',${SESSION_STARTED - 60})`,
    )
    expect(result.failed).toBe(false)
    expect(Object.keys(result.files())).toEqual(['1-a.jpg', '2-b.jpg', '3-c.jpg'])
  })

  it('stops when the account under that sign-in is replaced by another', async () => {
    expectStopped(
      await changeWhileStreaming(
        await start(BOB),
        `UPDATE gallery_access_objects SET auth0_user_id='auth0|bob-old' WHERE name='BOB';
         UPDATE gallery_access_objects SET auth0_user_id='${BOB.subject}' WHERE name='ALICE'`,
      ),
    )
  })

  it('stops when the account is being deleted', async () => {
    expectStopped(
      await changeWhileStreaming(
        await start(BOB),
        "UPDATE gallery_access_objects SET deleting=true WHERE name='BOB'",
      ),
    )
  })

  it('appends nothing of a file when the account is disabled after storage answered', async () => {
    whileStorageAnswers = { 'originals/b.jpg': DISABLE_BOB }
    const result = await changeWhileStreaming(await start(BOB), 'SELECT 1')
    expect(result.failed).toBe(true)
    expect(result.received.includes(Buffer.from('bytes-of-original-B'))).toBe(false)
    expect(result.received.includes(Buffer.from('bytes-of-original-C'))).toBe(false)
    expect(opened).toEqual(['originals/a.jpg', 'originals/b.jpg'])
  })

  it('is not stopped by a change to another account or another session', async () => {
    const result = await changeWhileStreaming(
      await start(BOB),
      `UPDATE photo_security.app_principals SET enabled=false WHERE marker='${OWNER.marker}';
       SELECT photo_security.revoke_session('${OWNER.sid}')`,
    )
    expect(result.failed).toBe(false)
    expect(Object.keys(result.files())).toEqual(['1-a.jpg', '2-b.jpg', '3-c.jpg'])
  })

  it('applies a narrower role to the remaining files instead of the one it began with', async () => {
    // The owner reads Alice's private album only as main administrator. Reduced to an
    // ordinary member mid-transfer, the remaining files are no longer theirs to read:
    // the archive completes with what was already sent.
    const result = await changeWhileStreaming(
      await start(OWNER),
      `DELETE FROM gallery_main_admins WHERE username='OWNER';
       UPDATE photo_security.app_memberships SET role_key='viewer' WHERE marker='${OWNER.marker}'`,
    )
    expect(result.failed).toBe(false)
    expect(Object.keys(result.files())).toEqual(['1-a.jpg'])
    expect(result.received.includes(Buffer.from('bytes-of-original-B'))).toBe(false)
    expect(result.received.includes(Buffer.from('bytes-of-original-C'))).toBe(false)
    expect(opened).toEqual(['originals/a.jpg'])
  })

  it('still leaves out a file the caller can no longer read', async () => {
    const result = await changeWhileStreaming(
      await start(BOB),
      'INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility)' +
        " VALUES(4,4,'Alice private','alice-2','ALICE','PRIVATE');" +
        'UPDATE photos SET event_id=4 WHERE photo_id=2',
    )
    expect(result.failed).toBe(false)
    expect(Object.keys(result.files())).toEqual(['1-a.jpg', '3-c.jpg'])
    expect(opened).toEqual(['originals/a.jpg', 'originals/c.jpg'])
  })

  it('cancels the open original when the client disconnects', async () => {
    const response = await start(BOB)
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    finishA()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(opened).toEqual(['originals/a.jpg'])
  })
})

// The refresh function repeats the sign-in functions' rules without claiming an assertion.
// If a rule is ever added to sign-in and not to it, a running download would keep an
// authority a new request no longer gets. For every state below the two must agree.
describe('gateway_session_authority', () => {
  const STATES: Record<string, string> = {
    'active member': 'SELECT 1',
    'disabled account': DISABLE_BOB,
    'logged-out session': LOG_BOB_OUT,
    'no role': WITHDRAW_BOBS_ROLE,
    'no permission record': `DELETE FROM photo_security.app_principals WHERE marker='${BOB.marker}'`,
    'account being deleted': "UPDATE gallery_access_objects SET deleting=true WHERE name='BOB'",
    'account not ready': "UPDATE gallery_access_objects SET state='pending' WHERE name='BOB'",
    'credentials changed after the session began': `INSERT INTO photo_security.credential_cutoffs(subject,cutoff) VALUES('${BOB.subject}',${SESSION_STARTED + 60})`,
    'credentials changed before the session began': `INSERT INTO photo_security.credential_cutoffs(subject,cutoff) VALUES('${BOB.subject}',${SESSION_STARTED - 60})`,
    'main administrator': "INSERT INTO gallery_main_admins(username) VALUES('BOB')",
  }
  const rows = async (sql: string, parameters: unknown[]) =>
    (await s.db.query(sql, parameters)).rows

  for (const [state, change] of Object.entries(STATES))
    for (const startedAt of [SESSION_STARTED, null])
      it(`agrees with sign-in: ${state}, ${startedAt ? 'with' : 'without'} a session start`, async () => {
        await s.db.exec(change)
        const expiry = Math.floor(Date.now() / 1000) + 20
        const session = [BOB.subject, BOB.sid]
        expect(
          await rows(
            'SELECT * FROM photo_security.gateway_session_authority($1,$2::uuid,$3,true)',
            [...session, startedAt],
          ),
        ).toEqual(
          await rows(
            'SELECT * FROM photo_security.gateway_customer_identity_once($1,$2::uuid,$3::uuid,$4,$5)',
            [...session, randomUUID(), expiry, startedAt],
          ),
        )
        expect(
          await rows(
            'SELECT * FROM photo_security.gateway_session_authority($1,$2::uuid,$3,false)',
            [...session, startedAt],
          ),
        ).toEqual(
          await rows(
            'SELECT * FROM photo_security.gateway_app_identity_once($1,$2::uuid,$3::uuid,$4)',
            [...session, randomUUID(), expiry],
          ),
        )
      })

  it('claims no assertion', async () => {
    await rows('SELECT * FROM photo_security.gateway_session_authority($1,$2::uuid,$3,true)', [
      BOB.subject,
      BOB.sid,
      SESSION_STARTED,
    ])
    expect(await rows('SELECT jti FROM photo_security.gateway_assertions', [])).toHaveLength(0)
  })

  it('can be run by the application login and by no one else', async () => {
    const grants = await rows(
      `SELECT r.rolname FROM pg_proc p, aclexplode(p.proacl) a JOIN pg_roles r ON r.oid=a.grantee
       WHERE p.proname='gateway_session_authority' AND a.privilege_type='EXECUTE' AND r.oid<>p.proowner`,
      [],
    )
    expect(grants).toEqual([{ rolname: 'personal_photos_app' }])
  })
})
