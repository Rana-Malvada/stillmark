import { applyTestDatabaseSteps, createTestDatabase } from './fixtures/test-database'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'

let db: PGlite
const issuer = 'https://test.auth0.com/'
const admin = randomUUID()
const expiry = () => Math.floor(Date.now() / 1000) + 30
async function asApp<T>(fn: () => Promise<T>, name = '') {
  await db.exec('BEGIN;SET LOCAL ROLE personal_photos_app')
  try {
    await db.query(
      "SELECT set_config('photos.username',$1,true),set_config('photos.can_write','true',true)",
      [name],
    )
    const value = await fn()
    await db.exec('COMMIT')
    return value
  } catch (e) {
    await db.exec('ROLLBACK')
    throw e
  }
}
async function signup(
  subject: string,
  verified = true,
  jti = randomUUID(),
  email = 'member@example.com',
  iss = issuer,
) {
  return asApp(async () => {
    return (
      await db.query<{ name: string }>(
        'SELECT photo_security.register_customer($1,$2,$3,$4,$5,$6,$7) AS name',
        [subject, iss, email, 'New Member', verified, jti, expiry()],
      )
    ).rows[0].name
  })
}
async function identity(subject: string, started: number | null) {
  return asApp(
    async () =>
      (
        await db.query<any>(
          'SELECT * FROM photo_security.gateway_customer_identity_once($1,$2,$3,$4,$5)',
          [subject, randomUUID(), randomUUID(), expiry(), started],
        )
      ).rows[0],
  )
}
beforeAll(async () => {
  db = await createTestDatabase({
    extensions: true,
    roles: [
      'snowflake_admin',
      'personal_photos_app NOINHERIT',
      'personal_photos_reader',
      'personal_photos_video_worker',
      'personal_photos_maintenance',
    ],
    steps: [
      {
        sql: 'SET search_path=public;GRANT USAGE ON SCHEMA public TO personal_photos_app;GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO personal_photos_app;GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO personal_photos_app;',
      },
      'setup/71-catalog-read-rls.sql',
      'setup/72-app-rls.sql',
      '202610062030_gateway_security',
      '202610280100_app_permissions',
      '202610251400_album_permission_queries',
      '202610251430_permission_list_indexes',
      '202610270130_indexed_app_photo_policy',
      '202610072000_people_faces',
    ],
  })
  await db.query(
    "INSERT INTO gallery_access_objects(kind,name,marker,display_name,created_by,state,auth0_user_id) VALUES('user','GALLERYOWNER',$1,'Existing Admin','test','ready','auth0|existing')",
    [admin],
  )
  await db.query('INSERT INTO photo_security.app_principals(marker) VALUES($1)', [admin])
  await db.query(
    "INSERT INTO photo_security.app_memberships(marker,role_key) VALUES($1,'app_owner')",
    [admin],
  )
  await applyTestDatabaseSteps(db, [
    '202610301200_customer_registration',
    '202610301500_customer_default_allowances',
    '202610301600_shared_collection_accounts',
    '202610302230_deleted_accounts',
    '202610302235_no_automatic_folder',
    '202610310300_deleted_account_archive_insert',
    '202610242230_upload_routing',
    '202610242350_upload_processing_queue',
    '202610290200_upload_chunk_reservations',
    '202611081510_upload_account_authority',
  ])
  await db.query('UPDATE photo_security.registration_settings SET issuer=$1', [issuer])
}, 30000)
afterAll(async () => db?.close())
it('defaults closed; does not alter existing admin identity or usage ownership', async () => {
  await expect(signup('auth0|closed')).rejects.toThrow(/Registration closed/)
  const old = await identity('auth0|existing', Math.floor(Date.now() / 1000))
  expect(old).toMatchObject({
    name: 'GALLERYOWNER',
    marker: admin,
    app_role: 'admin',
    app_owner: true,
    can_manage_access: true,
  })
  expect(await signup('auth0|existing', false)).toBe('GALLERYOWNER')
})
it('rejects unverified/wrong-issuer identities without leaving partially provisioned accounts', async () => {
  await db.exec('UPDATE photo_security.registration_settings SET enabled=true')
  await expect(signup('auth0|unverified', false)).rejects.toThrow(/Verified/)
  await expect(
    signup('auth0|wrong', true, randomUUID(), 'new@example.com', 'https://other.auth0.com/'),
  ).rejects.toThrow(/Issuer/)
  expect(
    (
      await db.query(
        "SELECT * FROM gallery_access_objects WHERE auth0_user_id IN ('auth0|unverified','auth0|wrong')",
      )
    ).rows,
  ).toHaveLength(0)
})
it('creates a stable member without an automatic folder or inherited admin/groups and no email linking', async () => {
  const first = await signup('auth0|alice')
  const second = await signup('auth0|bob')
  expect(first).not.toBe(second)
  expect(await signup('auth0|alice')).toBe(first)
  expect(await identity('auth0|alice', Math.floor(Date.now() / 1000))).toMatchObject({
    name: first,
    app_role: 'viewer',
    app_owner: false,
    can_manage_personal: true,
    can_manage_access: false,
  })
  expect(
    (await db.query('SELECT * FROM folders WHERE owner_username=$1', [first])).rows,
  ).toHaveLength(0)
  const grants = await db.query<any>(
    'SELECT role_key FROM photo_security.app_memberships m JOIN gallery_access_objects o USING(marker) WHERE o.name=$1',
    [first],
  )
  expect(grants.rows).toEqual([{ role_key: 'member' }])
  expect(
    (await db.query('SELECT * FROM face_settings WHERE owner_username=$1', [first])).rows,
  ).toHaveLength(0)
})
it('rejects replay and keeps disabled accounts disabled across callbacks', async () => {
  const jti = randomUUID()
  await signup('auth0|replay', true, jti)
  await expect(signup('auth0|replay', true, jti)).rejects.toThrow(/replayed/)
  await db.exec(
    "UPDATE photo_security.app_principals SET enabled=false WHERE marker=(SELECT marker FROM gallery_access_objects WHERE auth0_user_id='auth0|replay')",
  )
  await expect(signup('auth0|replay')).rejects.toThrow(/unavailable/)
})
it('preserves private albums and explicit shares while allowing GALLERY content', async () => {
  const alice = await signup('auth0|alice')
  const bob = await signup('auth0|bob')
  await db.query(
    "INSERT INTO folders(folder_name,owner_username) VALUES('Trips',$1),('Trips',$2)",
    [alice, bob],
  )
  await db.query(
    "INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES(9001,1,'Mine','signup-a',$1,'PRIVATE'),(9002,2,'Other','signup-b',$2,'PRIVATE'),(9003,3,'Legacy','signup-c','GALLERYOWNER','GALLERY')",
    [alice, bob],
  )
  await db.exec(
    "INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status) VALUES(9001,9001,'a.jpg','photo','READY'),(9002,9002,'b.jpg','photo','READY'),(9003,9003,'c.jpg','photo','READY')",
  )
  await asApp(async () => {
    expect((await db.query('SELECT event_id FROM events ORDER BY event_id')).rows).toEqual([
      { event_id: 9001 },
      { event_id: 9003 },
    ])
    expect((await db.query('SELECT photo_id FROM photos ORDER BY photo_id')).rows).toEqual([
      { photo_id: 9001 },
      { photo_id: 9003 },
    ])
    expect((await db.query<any>('SELECT photo_security.read_event(9002) AS ok')).rows[0].ok).toBe(
      false,
    )
    expect((await db.query('SELECT * FROM folders')).rows).toHaveLength(1)
  }, alice)
  await db.query('INSERT INTO album_shares(event_id,username,created_by) VALUES(9002,$1,$2)', [
    alice,
    bob,
  ])
  await asApp(
    async () =>
      expect((await db.query('SELECT event_id FROM events ORDER BY event_id')).rows).toEqual([
        { event_id: 9001 },
        { event_id: 9002 },
        { event_id: 9003 },
      ]),
    alice,
  )
  await asApp(
    async () =>
      expect((await db.query('SELECT event_id FROM events ORDER BY event_id')).rows).toEqual([
        { event_id: 9003 },
      ]),
    'LEGACY',
  )
})
it('blocks public admissions until a bounded allowance is granted, without changing existing users', async () => {
  const name = await signup('auth0|quota')
  const upload = randomUUID()
  await expect(
    asApp(
      () =>
        db.query('INSERT INTO upload_sessions(upload_id,owner,total_chunks) VALUES($1,$2,1)', [
          upload,
          name,
        ]),
      name,
    ),
  ).rejects.toThrow(/allowance/)
  await asApp(
    () => db.query('SELECT photo_security.set_customer_allowance($1,1,8388608)', [name]),
    'GALLERYOWNER',
  )
  await asApp(
    () =>
      db.query('INSERT INTO upload_sessions(upload_id,owner,total_chunks) VALUES($1,$2,1)', [
        upload,
        name,
      ]),
    name,
  )
  await expect(
    asApp(
      () =>
        db.query('INSERT INTO upload_sessions(upload_id,owner,total_chunks) VALUES($1,$2,1)', [
          randomUUID(),
          name,
        ]),
      name,
    ),
  ).rejects.toThrow(/allowance/)
  await asApp(
    () =>
      db.query(
        "INSERT INTO upload_sessions(upload_id,owner,total_chunks) VALUES($1,'GALLERYOWNER',1)",
        [randomUUID()],
      ),
    'GALLERYOWNER',
  )
})
it('revokes prior sessions on credential change; later login works; old event cannot undo revocation', async () => {
  const cutoff = Math.floor(Date.now() / 1000) - 10
  await asApp(() =>
    db.query("SELECT photo_security.record_credential_change('auth0|alice',$1)", [cutoff]),
  )
  expect((await identity('auth0|alice', cutoff - 1)).revoked).toBe(true)
  expect((await identity('auth0|alice', null)).revoked).toBe(true)
  expect((await identity('auth0|alice', cutoff + 1)).revoked).toBe(false)
  await asApp(() =>
    db.query("SELECT photo_security.record_credential_change('auth0|alice',$1)", [cutoff - 20]),
  )
  expect((await identity('auth0|alice', cutoff - 1)).revoked).toBe(true)
})
it('profile updates do not change identity, and deletion requests disable reactivation', async () => {
  const name = await signup('auth0|delete')
  await asApp(() => db.query("SELECT photo_security.update_customer_profile('Updated name')"), name)
  expect(await signup('auth0|delete')).toBe(name)
  await asApp(() => db.query('SELECT photo_security.request_account_deletion()'), name)
  expect((await identity('auth0|delete', Math.floor(Date.now() / 1000))).enabled).toBe(false)
  await expect(signup('auth0|delete')).rejects.toThrow(/unavailable/)
})
it('deletion revokes queued authority without invalidating other owners or successful replay', async () => {
  const name = await signup('auth0|delete-uploads')
  const other = await signup('auth0|keep-uploads')
  const pending = randomUUID()
  const completed = randomUUID()
  const unrelated = randomUUID()
  await db.query(
    'UPDATE photo_security.customer_accounts SET upload_limit=100,byte_limit=1000000000 WHERE marker IN (SELECT marker FROM gallery_access_objects WHERE name=ANY($1::text[]))',
    [[name, other]],
  )
  for (const [id, owner, result] of [
    [pending, name, null],
    [completed, name, { eventId: 7 }],
    [unrelated, other, null],
  ]) {
    await db.query(
      'INSERT INTO upload_sessions(upload_id,owner,total_chunks,result) VALUES($1,$2,1,$3)',
      [id, owner, result],
    )
    await db.query(
      `INSERT INTO upload_processing_jobs(upload_id,owner,body,caller,auth_epoch,state)
       VALUES($1,$2,'{}','{}',photo_security.authorization_epoch()::text,$3)`,
      [id, owner, result ? 'done' : 'queued'],
    )
  }
  await db.query(
    `INSERT INTO upload_chunks(upload_id,chunk_index,stage_path,byte_size,hash)
     VALUES($1,0,$2,1,'hash')`,
    [pending, `upload-chunks/${pending}/part`],
  )
  await db.query('INSERT INTO stage_cleanup(path,next_attempt) VALUES($1,now())', [
    `upload-chunks/${pending}/part`,
  ])
  const epoch = (await db.query('SELECT photo_security.authorization_epoch() AS epoch')).rows[0]
  const allowed = (owner: string) =>
    asApp(
      async () =>
        (
          await db.query<{ allowed: boolean }>(
            'SELECT photo_security.upload_account_allowed($1) AS allowed',
            [owner],
          )
        ).rows[0].allowed,
      owner,
    )
  expect(await allowed(name)).toBe(true)
  await asApp(() => db.query('SELECT photo_security.request_account_deletion()'), name)
  expect(await allowed(name)).toBe(false)
  expect(await allowed(other)).toBe(true)
  expect((await db.query('SELECT photo_security.authorization_epoch() AS epoch')).rows[0]).toEqual(
    epoch,
  )
  expect(
    (await db.query('SELECT upload_id FROM upload_processing_jobs ORDER BY upload_id')).rows,
  ).toEqual([completed, unrelated].sort().map((upload_id) => ({ upload_id })))
  expect(
    (await db.query('SELECT result FROM upload_sessions WHERE upload_id=$1', [completed])).rows,
  ).toEqual([{ result: { eventId: 7 } }])
  expect(
    (await db.query('SELECT * FROM upload_chunks WHERE upload_id=$1', [pending])).rows,
  ).toEqual([])
  expect(
    (
      await db.query('SELECT path FROM stage_cleanup WHERE path=$1', [
        `upload-chunks/${pending}/part`,
      ])
    ).rows,
  ).toHaveLength(1)
  // A stale request cannot ask about or borrow another customer's account fence.
  expect(
    await asApp(
      async () =>
        (
          await db.query<{ allowed: boolean }>(
            'SELECT photo_security.upload_account_allowed($1) AS allowed',
            [other],
          )
        ).rows[0].allowed,
      name,
    ),
  ).toBe(false)
  await db.query(
    'UPDATE photo_security.app_principals SET enabled=false WHERE marker IN (SELECT marker FROM gallery_access_objects WHERE name=$1)',
    [other],
  )
  expect(await allowed(other)).toBe(false)
})
it('members cannot edit settings, authority tables, another allowance or grant themselves admin', async () => {
  const name = await signup('auth0|alice')
  for (const table of ['registration_settings', 'customer_accounts', 'credential_cutoffs'])
    await expect(
      asApp(() => db.query('SELECT * FROM photo_security.' + table), name),
    ).rejects.toThrow(/permission denied/)
  await expect(
    asApp(
      () => db.query('SELECT photo_security.set_customer_allowance($1,999,999999)', [name]),
      name,
    ),
  ).rejects.toThrow(/Access manager/)
})
it('bounds paid search separately without changing legacy user access', async () => {
  const name = await signup('auth0|search-budget')
  const allowed = () =>
    asApp(
      async () =>
        (await db.query<any>('SELECT photo_security.admit_customer_search_ai() AS allowed')).rows[0]
          .allowed,
      name,
    )
  expect(await allowed()).toBe(false)
  await asApp(
    () => db.query('SELECT photo_security.set_customer_allowance($1,0,0,2)', [name]),
    'GALLERYOWNER',
  )
  expect(await allowed()).toBe(true)
  expect(await allowed()).toBe(true)
  expect(await allowed()).toBe(false)
  expect(
    await asApp(
      async () =>
        (await db.query<any>('SELECT photo_security.admit_customer_search_ai() AS allowed')).rows[0]
          .allowed,
      'GALLERYOWNER',
    ),
  ).toBe(true)
})
it('only admins change defaults; changes are audited and apply only to later accounts', async () => {
  const existing = await signup('auth0|defaults-before')
  const budgets = async (name: string) =>
    (
      await db.query<any>(
        'SELECT upload_limit,byte_limit,ai_search_limit FROM photo_security.customer_accounts c JOIN gallery_access_objects o USING(marker) WHERE o.name=$1',
        [name],
      )
    ).rows[0]
  const before = await budgets(existing)
  for (const query of [
    'SELECT photo_security.customer_default_allowances()',
    'SELECT photo_security.set_customer_default_allowances(1000,10737418240)',
  ])
    await expect(asApp(() => db.query(query), existing)).rejects.toThrow(/Access manager/)
  await expect(
    asApp(
      () => db.query('SELECT photo_security.set_customer_default_allowances(-1,0)'),
      'GALLERYOWNER',
    ),
  ).rejects.toThrow(/Invalid allowance/)
  const settingsBefore = (
    await db.query<any>(
      'SELECT enabled,issuer,default_ai_searches FROM photo_security.registration_settings',
    )
  ).rows[0]
  await asApp(
    () => db.query('SELECT photo_security.set_customer_default_allowances(1000,10737418240)'),
    'GALLERYOWNER',
  )
  expect(await budgets(existing)).toEqual(before)
  expect(
    (
      await db.query<any>(
        'SELECT enabled,issuer,default_ai_searches FROM photo_security.registration_settings',
      )
    ).rows[0],
  ).toEqual(settingsBefore)
  expect(await budgets(await signup('auth0|defaults-after'))).toMatchObject({
    upload_limit: 1000,
    byte_limit: 10737418240,
  })
  expect(
    (
      await asApp(
        () => db.query<any>('SELECT photo_security.customer_default_allowances() AS defaults'),
        'GALLERYOWNER',
      )
    ).rows[0].defaults,
  ).toEqual({ uploads: 1000, bytes: 10737418240 })
  expect(
    (
      await db.query<any>(
        "SELECT actor,value FROM photo_security.app_permission_audit WHERE action='customer_default_allowances'",
      )
    ).rows,
  ).toHaveLength(1)
})

it('scoped catalog reader preserves private isolation, all-user sharing and explicit shares', async () => {
  const name = await signup('auth0|reader-only')
  await db.query(
    "INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES(9010,10,'Reader own','reader-own',$1,'PRIVATE')",
    [name],
  )
  await db.exec(
    "INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status) VALUES(9010,9010,'reader.jpg','photo','READY')",
  )
  async function read(who: string, main = false) {
    await db.exec('BEGIN;SET LOCAL ROLE personal_photos_reader')
    try {
      await db.query(
        "SELECT set_config('photos.username',$1,true),set_config('photos.main_admin',$2,true)",
        [who, String(main)],
      )
      const albums = (
        await db.query<{ event_id: number }>('SELECT event_id FROM events ORDER BY event_id')
      ).rows.map((x) => x.event_id)
      const photos = (
        await db.query<{ photo_id: number }>('SELECT photo_id FROM photos ORDER BY photo_id')
      ).rows.map((x) => x.photo_id)
      return { albums, photos }
    } finally {
      await db.exec('ROLLBACK')
    }
  }
  expect(await read(name)).toEqual({ albums: [9003, 9010], photos: [9003, 9010] })
  expect(await read('')).toEqual({ albums: [], photos: [] })
  expect((await read('LEGACY')).albums).toContain(9003)
  expect((await read('GALLERYOWNER', true)).albums).toContain(9010)
  await db.query(
    "INSERT INTO album_shares(event_id,username,created_by) VALUES(9002,$1,'GALLERYOWNER')",
    [name],
  )
  expect(await read(name)).toEqual({ albums: [9002, 9003, 9010], photos: [9002, 9003, 9010] })
})

it('keeps archived content admin-only even with stale sharing and the former owner identity', async () => {
  await db.exec(`INSERT INTO deleted_accounts(name,marker,display_name,joined_at,deleted_by)
    VALUES('ARCHIVED',gen_random_uuid(),'Former member',now(),'GALLERYOWNER');
    INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility,archived_account)
    VALUES(9901,9901,'Archived album','archived','ARCHIVED','GALLERY',true);
    INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path)
    VALUES(9901,9901,'archived.jpg','photo','READY','archived');
    INSERT INTO album_shares(event_id,username,created_by) VALUES(9901,'NEW_ACCOUNT','ARCHIVED');
    INSERT INTO album_public_links(id,event_id,token_hash,owner_username,created_by,expires_at)
    VALUES(gen_random_uuid(),9901,repeat('f',64),'ARCHIVED','ARCHIVED',now()+interval '1 day');`)
  for (const name of ['', 'NEW_ACCOUNT', 'ARCHIVED']) {
    await asApp(async () => {
      await db.query("SELECT set_config('photos.public_hash',repeat('f',64),true)")
      expect((await db.query('SELECT * FROM events WHERE event_id=9901')).rows).toEqual([])
      expect((await db.query('SELECT * FROM photos WHERE photo_id=9901')).rows).toEqual([])
      expect((await db.query('SELECT * FROM deleted_accounts')).rows).toEqual([])
      expect((await db.query('SELECT photo_security.read_event(9901) AS allowed')).rows[0]).toEqual(
        { allowed: false },
      )
      expect((await db.query('SELECT photo_security.edit_event(9901) AS allowed')).rows[0]).toEqual(
        { allowed: false },
      )
      expect((await db.query('SELECT photo_security.public_event() AS id')).rows[0]).toEqual({
        id: null,
      })
    }, name)
  }
  await asApp(async () => {
    await db.query("SELECT set_config('photos.main_admin','true',true)")
    expect((await db.query('SELECT owner_username FROM events WHERE event_id=9901')).rows).toEqual([
      { owner_username: 'ARCHIVED' },
    ])
    expect((await db.query('SELECT photo_id FROM photos WHERE photo_id=9901')).rows).toHaveLength(1)
  }, 'GALLERYOWNER')
  await expect(
    db.exec(
      "INSERT INTO gallery_access_objects(kind,name,marker,display_name,created_by) VALUES('user','ARCHIVED',gen_random_uuid(),'Recreated','test')",
    ),
  ).rejects.toThrow(/cannot be reused/)
})

it('allows an access manager to archive an existing identity but rejects ordinary members', async () => {
  const name = await signup('auth0|archive-insert')
  const insert = () =>
    db.query(
      `INSERT INTO deleted_accounts(name,marker,display_name,email,joined_at,deleted_by)
    SELECT name,marker,display_name,email,created_at,'GALLERYOWNER' FROM gallery_access_objects WHERE name=$1`,
      [name],
    )
  await expect(asApp(insert, name)).rejects.toThrow()
  await asApp(async () => {
    await db.query(
      "SELECT set_config('photos.access_manager','true',true),set_config('photos.main_admin','true',true)",
    )
    await insert()
    expect(
      (await db.query('SELECT name FROM deleted_accounts WHERE name=$1', [name])).rows,
    ).toHaveLength(1)
  }, 'GALLERYOWNER')
})
