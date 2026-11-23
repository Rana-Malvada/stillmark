// What happens to an accepted, queued upload when access changes before the worker
// publishes it, proven by outcome. The real acceptance route, queue worker, permission
// functions, publication fence and row-level security run against the full migrated schema;
// only the process edges are replaced (see fixtures/route-database).
//
// The gallery's roles live in PostgreSQL here, as deployed (`APP_PERMISSION_AUTHORITY=
// postgres`). The fixture signs a member in with platform headers, so the authority is
// switched only for the moment an upload is accepted; the worker always runs with it on.
import {
  APP_ORIGIN,
  type Caller,
  callerHeaders,
  createRouteDatabase,
  DATABASE_ENV,
  snowflakeRoleRows,
} from './fixtures/route-database'
import type { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  headers: new Headers(),
  caller: null as Caller | null,
  stage: new Map<string, Buffer>(),
  /** Runs once while the worker writes prepared media: after it authorized the job and
   * before it publishes. */
  whileProcessing: null as null | (() => Promise<void>),
}))
vi.mock('pg', async () =>
  (await import('./fixtures/route-database')).pgliteDriver(
    await vi.importActual<typeof import('pg')>('pg'),
    () => s.db,
  ),
)
vi.mock('next/headers', () => ({ headers: async () => s.headers }))
vi.mock('@/lib/snowflake', () => ({
  getServiceToken: () => 'platform-session',
  querySnowflake: async () => snowflakeRoleRows(s.caller),
  // A retried job reads its chunk again through a signed address; sign it for the stand-in.
  querySnowflakeStorage: async (sql: string) => [
    Object.fromEntries(
      [...sql.matchAll(/'(upload-chunks\/[^']+)', 300\) AS (URL\d+)/g)].map((m) => [
        m[2],
        'https://stage.invalid/' + m[1],
      ]),
    ),
  ],
}))
vi.mock('@/lib/snowflake/stage-upload', () => {
  const put = async (buffer: Buffer | string, path: string) => {
    if (typeof buffer === 'string') throw new Error('Unexpected file upload by path')
    s.stage.set(path, Buffer.from(buffer))
  }
  return {
    putFileToStage: put,
    putFilesToStage: async (files: Array<{ buffer: Buffer | string; stagePath: string }>) => {
      const change = s.whileProcessing
      s.whileProcessing = null
      await change?.()
      for (const file of files) await put(file.buffer, file.stagePath)
    },
    cleanupStage: async () => {},
  }
})
import { POST as sendChunk } from '@/app/api/upload/chunk/route'
import { POST as complete } from '@/app/api/upload/complete/route'
import { closePool } from '@/lib/postgres'
import { claimUploadJob, processUploadJob } from '@/lib/upload/upload-processing-worker'

const ALICE = '0a11ce00-0000-4000-8000-000000000001'
const BOB = '00000b0b-0000-4000-8000-000000000002'
const OWNER = '00000000-0000-4000-8000-000000000003'
const GROUP = '00000000-0000-4000-8000-000000000004'
const CHANGED = 'Permissions changed; retry this upload after checking access'
let jpeg: Buffer
const rows = async (sql: string) => (await s.db.query(sql)).rows as Record<string, unknown>[]
const jobs = () => rows('SELECT owner,state,error FROM upload_processing_jobs ORDER BY owner')
const photos = () => rows('SELECT event_id FROM photos')
const epoch = async () =>
  (await rows('SELECT photo_security.authorization_epoch()::text AS e'))[0].e

/** A member finishes sending a file and the upload service accepts it for processing. */
async function accept(username: string, eventId: number, uploadId: string = randomUUID()) {
  vi.stubEnv('APP_PERMISSION_AUTHORITY', 'snowflake')
  try {
    s.caller = { username, roles: ['viewer'] }
    s.headers = callerHeaders(s.caller)
    const form = new FormData()
    form.set('uploadId', uploadId)
    form.set('totalChunks', '1')
    form.set('chunkIndex', '0')
    form.set('chunk', new File([new Uint8Array(jpeg)], 'photo.jpg'))
    const sent = await sendChunk(
      new Request(APP_ORIGIN + '/api/upload/chunk', { method: 'POST', body: form }),
    )
    expect(sent.status).toBe(200)
    const queued = await complete(
      new Request(APP_ORIGIN + '/api/upload/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          uploadId,
          totalChunks: 1,
          fileName: 'photo.jpg',
          folderName: 'Holiday',
          eventId,
          queuedProcessing: true,
        }),
      }),
    )
    expect(queued.status).toBe(202)
  } finally {
    // The worker has no session of its own.
    s.caller = null
    s.headers = callerHeaders(null)
    vi.stubEnv('APP_PERMISSION_AUTHORITY', 'postgres')
  }
  return uploadId
}
/** The upload worker drains everything that is ready to run. */
async function work() {
  for (let job = await claimUploadJob(); job; job = await claimUploadJob())
    await processUploadJob(job)
}
/**
 * An access-management operation by the app owner, with the real permission functions as
 * the web login under row-level security. Like `runAccessOperation`, it advances the
 * global authorization epoch before and after the change.
 */
async function accessChange(
  change: (run: (sql: string, args?: unknown[]) => Promise<void>) => Promise<void>,
) {
  await s.db.exec('BEGIN;SET LOCAL ROLE personal_photos_app')
  try {
    await s.db.query(
      "SELECT set_config('photos.username','OWNER',true),set_config('photos.access_manager','true',true)",
    )
    await s.db.query('SELECT photo_security.invalidate_authorization()')
    await change(async (sql, args) => void (await s.db.query(sql, args)))
    await s.db.query('SELECT photo_security.invalidate_authorization()')
    await s.db.exec('COMMIT')
  } catch (error) {
    await s.db.exec('ROLLBACK')
    throw error
  }
}
const permission = (name: string, marker: string, action: string, value: string) =>
  accessChange((run) =>
    run('SELECT photo_security.change_app_permission($1::uuid,$2,$3::uuid,$4,$5)', [
      randomUUID(),
      name,
      marker,
      action,
      value,
    ]),
  )
/** A permission change that commits without the operation's epoch advances. */
const permissionWithoutEpoch = async (
  name: string,
  marker: string,
  action: string,
  value: string,
) => {
  const before = await epoch()
  await permission(name, marker, action, value)
  await s.db.query('UPDATE photo_security.authorization_revision SET revision=$1::bigint', [before])
}

beforeAll(async () => {
  for (const [name, value] of Object.entries(DATABASE_ENV)) vi.stubEnv(name, value)
  vi.stubEnv('UPLOAD_SERVICE_ONLY', 'true')
  vi.stubEnv('UPLOAD_PROCESSING_QUEUE_ENABLED', 'true')
  vi.stubEnv('CUSTOMER_ACCOUNTS_ENABLED', 'true')
  vi.stubEnv('APP_PERMISSION_AUTHORITY', 'postgres')
  s.db = await createRouteDatabase()
  jpeg = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 80, b: 40 } },
  })
    .jpeg()
    .toBuffer()
}, 60_000)
afterAll(async () => {
  await closePool()
  await s.db?.close()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
beforeEach(async () => {
  s.stage.clear()
  s.whileProcessing = null
  // The only network address in these tests is the stand-in stage.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const stored = s.stage.get(String(url).replace('https://stage.invalid/', ''))
      return stored ? new Response(new Uint8Array(stored)) : new Response(null, { status: 404 })
    }),
  )
  // Alice and Bob are members, each with a private album (1 and 2); Owner owns the app.
  await s.db
    .exec(`DELETE FROM upload_sessions;DELETE FROM upload_start_limits;DELETE FROM upload_files;DELETE FROM upload_jobs;
 DELETE FROM photos;DELETE FROM events;DELETE FROM folders;DELETE FROM search_queue;DELETE FROM stage_cleanup;DELETE FROM gallery_main_admins;
 DELETE FROM photo_security.app_roles WHERE role_key LIKE 'group:%';DELETE FROM gallery_access_objects;
 UPDATE upload_routing SET phase='pool',enabled=true;
 INSERT INTO gallery_access_objects(kind,name,marker,display_name,created_by,state) VALUES
  ('user','ALICE','${ALICE}','Alice','test','ready'),('user','BOB','${BOB}','Bob','test','ready'),('user','OWNER','${OWNER}','Owner','test','ready');
 INSERT INTO photo_security.app_principals(marker) VALUES('${ALICE}'),('${BOB}'),('${OWNER}');
 INSERT INTO photo_security.app_memberships(marker,role_key) VALUES('${ALICE}','viewer'),('${BOB}','viewer'),('${OWNER}','app_owner');
 INSERT INTO folders(folder_id,folder_name,owner_username) VALUES(1,'Alice','ALICE'),(2,'Bob','BOB');
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility,folder_id) VALUES
  (1,1,'Alice private','alice','ALICE','PRIVATE',1),(2,2,'Bob private','bob','BOB','PRIVATE',2);`)
})

it.each([
  ['is given another role', () => permission('BOB', BOB, 'grant', 'admin_readonly')],
  ['loses a role', () => permission('BOB', BOB, 'revoke', 'viewer')],
  ['is disabled', () => permission('BOB', BOB, 'enabled', 'false')],
])('publishes Alice’s queued upload after Bob %s', async (_name, change) => {
  await accept('ALICE', 1)
  const accepted = await epoch()
  await change()
  // The job still carries the epoch it was accepted under, which is no longer current.
  expect(await rows('SELECT auth_epoch FROM upload_processing_jobs')).toEqual([
    { auth_epoch: accepted },
  ])
  expect(await epoch()).not.toBe(accepted)
  await work()
  expect(await jobs()).toEqual([{ owner: 'ALICE', state: 'done', error: null }])
  expect(await photos()).toEqual([{ event_id: 1 }])
})

it.each([
  ['is disabled', () => permission('ALICE', ALICE, 'enabled', 'false')],
  [
    'is reduced to a read-only role',
    async () => {
      await permission('ALICE', ALICE, 'grant', 'admin_readonly')
      await permission('ALICE', ALICE, 'revoke', 'viewer')
    },
  ],
  ['loses every role', () => permission('ALICE', ALICE, 'revoke', 'viewer')],
  [
    'is being deleted by an administrator',
    async () => {
      // The deletion command's operation advances the epoch, then marks the account.
      await accessChange(async () => {})
      await s.db.exec("UPDATE gallery_access_objects SET deleting=true WHERE name='ALICE'")
    },
  ],
])('publishes nothing when Alice %s while her upload is queued', async (_name, change) => {
  await accept('ALICE', 1)
  await change()
  await work()
  expect(await jobs()).toEqual([{ owner: 'ALICE', state: 'failed', error: CHANGED }])
  expect(await photos()).toEqual([])
  // Nothing was prepared either: only the received chunk is in storage.
  expect([...s.stage.keys()].every((path) => path.startsWith('upload-chunks/'))).toBe(true)
})

// The app owner may upload into a member's album only because of that role. Once it is
// taken away, a queued upload must not keep the authority it was accepted with.
const demoteOwner = async () => {
  // An administrator cannot change their own access, so the role is replaced directly,
  // inside an access operation that advances the epoch as a real one would.
  await accessChange(async () => {})
  await s.db.query(
    "UPDATE photo_security.app_memberships SET role_key='viewer' WHERE marker=$1::uuid",
    [OWNER],
  )
}
it('publishes nothing into a member’s album after the app owner is demoted while queued', async () => {
  await accept('OWNER', 1)
  await demoteOwner()
  await work()
  expect(await jobs()).toEqual([{ owner: 'OWNER', state: 'failed', error: 'Album not found' }])
  expect(await photos()).toEqual([])
})

it('refuses at publication when the app owner is demoted while the upload is processed', async () => {
  await accept('OWNER', 1)
  await permission('BOB', BOB, 'grant', 'admin_readonly')
  // The worker has already re-read Owner as the app owner when the role is replaced.
  s.whileProcessing = demoteOwner
  await work()
  // The attempt authorized Owner as the app owner, so it may not publish as anything else:
  // it is put back, and nothing has been published.
  expect(await jobs()).toMatchObject([{ owner: 'OWNER', state: 'queued' }])
  expect(await photos()).toEqual([])
  // The retry re-reads Owner as a member, who has no right to Alice's album.
  await s.db.exec('UPDATE upload_processing_jobs SET next_attempt=now()')
  await work()
  expect(await jobs()).toEqual([{ owner: 'OWNER', state: 'failed', error: 'Album not found' }])
  expect(await photos()).toEqual([])
})

it('publishes nothing when Alice loses the target album while her upload is queued', async () => {
  await accept('ALICE', 1)
  await s.db.exec("UPDATE events SET owner_username='BOB',folder_id=2 WHERE event_id=1")
  await permission('BOB', BOB, 'grant', 'admin_readonly')
  await work()
  // Her account is still in good standing, so the album check is what refuses the upload.
  expect(await jobs()).toEqual([{ owner: 'ALICE', state: 'failed', error: 'Album not found' }])
  expect(await photos()).toEqual([])
})

it('re-reads every owner after a change to a role definition, which affects everyone', async () => {
  // Both members hold their upload permission only through one shared group role.
  await s.db
    .exec(`INSERT INTO gallery_access_objects(kind,name,marker,profile,display_name,created_by,state)
   VALUES('role','PERSONAL_PHOTOS_GROUP_FAMILY','${GROUP}','viewer','Family','test','ready');
 INSERT INTO photo_security.app_roles(role_key,profile,marker) VALUES('group:FAMILY','viewer','${GROUP}');
 UPDATE photo_security.app_memberships SET role_key='group:FAMILY' WHERE role_key='viewer';`)
  await accept('ALICE', 1)
  await accept('BOB', 2)
  // A new role definition changes no one's access: both uploads are published.
  await accessChange((run) =>
    run(
      `INSERT INTO gallery_access_objects(kind,name,marker,profile,display_name,created_by,state)
       VALUES('role','PERSONAL_PHOTOS_GROUP_AUDIT',$1,'admin_readonly','Audit','OWNER','ready')`,
      [randomUUID()],
    ),
  )
  await work()
  expect(await jobs()).toEqual([
    { owner: 'ALICE', state: 'done', error: null },
    { owner: 'BOB', state: 'done', error: null },
  ])
  // The shared role becomes read-only: every member who relied on it is refused.
  await accept('ALICE', 1)
  await accept('BOB', 2)
  await accessChange(async () => {})
  await s.db.exec(
    "UPDATE photo_security.app_roles SET profile='admin_readonly' WHERE role_key='group:FAMILY'",
  )
  await work()
  expect(await rows("SELECT owner,error FROM upload_processing_jobs WHERE state='failed'")).toEqual(
    [
      { owner: 'ALICE', error: CHANGED },
      { owner: 'BOB', error: CHANGED },
    ],
  )
  expect(await photos()).toEqual([{ event_id: 1 }, { event_id: 2 }])
})

it('never uses the stored caller snapshot once the epoch has moved', async () => {
  // Alice aims an upload at Bob's private album, and her stored snapshot is made to claim
  // far more than the database grants: an app owner and main administrator may do that.
  await accept('ALICE', 2)
  await s.db.exec(`UPDATE upload_processing_jobs SET caller=caller||
   '{"role":"admin","appOwner":true,"mainAdmin":true,"canManagePersonal":true,"canManageAccess":true}'::jsonb`)
  await permission('BOB', BOB, 'grant', 'admin_readonly')
  await work()
  // The database says she is a member, so Bob's album does not exist for her.
  expect(await jobs()).toEqual([{ owner: 'ALICE', state: 'failed', error: 'Album not found' }])
  expect(await photos()).toEqual([])
})

it('uses what the database grants now, not a snapshot that names a different account', async () => {
  await accept('ALICE', 1)
  await s.db.exec(`UPDATE upload_processing_jobs SET caller=caller||'{"username":"BOB"}'::jsonb`)
  await permission('BOB', BOB, 'grant', 'admin_readonly')
  await work()
  // The job's owner column, bound at acceptance, decides whose authority is read.
  expect(await jobs()).toEqual([{ owner: 'ALICE', state: 'done', error: null }])
  expect(await photos()).toEqual([{ event_id: 1 }])
})

it('refuses at publication when Alice’s access is reduced while her upload is processed', async () => {
  await accept('ALICE', 1)
  await permission('BOB', BOB, 'grant', 'admin_readonly')
  // The worker has already re-read Alice as a member when her role is replaced.
  s.whileProcessing = async () => {
    await permission('ALICE', ALICE, 'grant', 'admin_readonly')
    await permission('ALICE', ALICE, 'revoke', 'viewer')
  }
  await work()
  // Publication's own account check is the first to see it, with its existing message.
  expect(await jobs()).toEqual([
    { owner: 'ALICE', state: 'failed', error: 'Upload account is disabled or pending deletion' },
  ])
  expect(await photos()).toEqual([])
})

it.each([
  ['true', 'Upload account is disabled or pending deletion'],
  // Without the customer account check, the confirmation in the publication transaction
  // is the only thing that sees it.
  ['false', CHANGED],
])(
  'refuses at publication even if the change committed without advancing the epoch (customer accounts %s)',
  async (customerAccounts, error) => {
    vi.stubEnv('CUSTOMER_ACCOUNTS_ENABLED', customerAccounts)
    try {
      await accept('ALICE', 1)
      await permission('BOB', BOB, 'grant', 'admin_readonly')
      // The epoch fence alone would pass here: publication confirms the owner's authority.
      s.whileProcessing = () => permissionWithoutEpoch('ALICE', ALICE, 'enabled', 'false')
      await work()
      expect(await jobs()).toEqual([{ owner: 'ALICE', state: 'failed', error }])
      expect(await photos()).toEqual([])
    } finally {
      vi.stubEnv('CUSTOMER_ACCOUNTS_ENABLED', 'true')
    }
  },
)

it('retries, then publishes, when the owner’s role changes but still allows the upload', async () => {
  await accept('ALICE', 1)
  await permission('BOB', BOB, 'grant', 'admin_readonly')
  // Alice becomes an administrator mid-flight, with no epoch advance to announce it.
  s.whileProcessing = () => permissionWithoutEpoch('ALICE', ALICE, 'grant', 'admin')
  await work()
  // The attempt authorized her as a member, so it may not publish as anything else.
  expect(await jobs()).toEqual([
    { owner: 'ALICE', state: 'queued', error: 'Upload job claim expired' },
  ])
  expect(await photos()).toEqual([])
  // The failed attempt left the job on the epoch it was accepted under.
  expect((await rows('SELECT auth_epoch FROM upload_processing_jobs'))[0].auth_epoch).not.toBe(
    await epoch(),
  )
  await s.db.exec('UPDATE upload_processing_jobs SET next_attempt=now()')
  await work()
  expect(await jobs()).toEqual([{ owner: 'ALICE', state: 'done', error: null }])
  expect(await photos()).toEqual([{ event_id: 1 }])
})

it('keeps the epoch fence: a later access change stops publication, and the retry succeeds', async () => {
  await accept('ALICE', 1)
  await permission('BOB', BOB, 'grant', 'admin_readonly')
  // Another access operation starts after the worker re-read Alice.
  s.whileProcessing = () => permission('BOB', BOB, 'revoke', 'admin_readonly')
  await work()
  expect(await jobs()).toEqual([
    { owner: 'ALICE', state: 'queued', error: 'Upload job claim expired' },
  ])
  expect(await photos()).toEqual([])
  await s.db.exec('UPDATE upload_processing_jobs SET next_attempt=now()')
  await work()
  expect(await jobs()).toEqual([{ owner: 'ALICE', state: 'done', error: null }])
  expect(await photos()).toEqual([{ event_id: 1 }])
})

it('where roles are not stored in PostgreSQL, still refuses a job from an earlier epoch', async () => {
  await accept('ALICE', 1)
  await permission('BOB', BOB, 'grant', 'admin_readonly')
  vi.stubEnv('APP_PERMISSION_AUTHORITY', 'snowflake')
  try {
    await work()
  } finally {
    vi.stubEnv('APP_PERMISSION_AUTHORITY', 'postgres')
  }
  expect(await jobs()).toEqual([{ owner: 'ALICE', state: 'failed', error: CHANGED }])
  expect(await photos()).toEqual([])
})

it('trusts nothing new when the epoch has not moved: an unchanged job runs as before', async () => {
  await accept('ALICE', 1)
  await work()
  expect(await jobs()).toEqual([{ owner: 'ALICE', state: 'done', error: null }])
  expect(await photos()).toEqual([{ event_id: 1 }])
})
