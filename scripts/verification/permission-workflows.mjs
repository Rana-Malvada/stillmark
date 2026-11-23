/** Real PostgreSQL permission workflows, with synthetic catalog rows only. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { withLocalPostgres } from './local-postgres.mjs'
import { createPermissionFixture } from './permission-fixture.mjs'

await withLocalPostgres(
  'permission-workflows',
  async ({ admin, clients }) => {
    const database = 'gallery_restore_check_' + randomUUID().replaceAll('-', '')
    await admin.query(`CREATE DATABASE "${database}"`)
    const db = new pg.Client({
      host: '127.0.0.1',
      port: admin.connectionParameters.port,
      user: 'postgres',
      database,
      statement_timeout: 10000,
      connectionTimeoutMillis: 1000,
    })
    clients.add(db)
    await db.connect()
    await createPermissionFixture(db)
    await db.query(readFileSync(new URL('./restored-permissions.sql', import.meta.url), 'utf8'))
    // These assertions use the real current authority functions, not stand-ins.
    const asApp = async (username, work) => {
      await db.query('BEGIN; SET LOCAL ROLE personal_photos_app')
      try {
        await db.query(
          "SELECT set_config('photos.username',$1,true),set_config('photos.can_write','true',true)",
          [username],
        )
        const result = await work()
        await db.query('COMMIT')
        return result
      } catch (error) {
        await db.query('ROLLBACK')
        throw error
      }
    }
    await db.query(
      "UPDATE photo_security.registration_settings SET enabled=true,issuer='https://test.auth0.com/'",
    )
    const signup = (
      subject,
      verified = true,
      assertion = randomUUID(),
      expiry = Math.floor(Date.now() / 1000) + 30,
      issuer = 'https://test.auth0.com/',
    ) =>
      asApp(
        '',
        async () =>
          (
            await db.query(
              'SELECT photo_security.register_customer($1,$2,$3,$4,$5,$6,$7) AS name',
              [subject, issuer, 'member@example.invalid', 'Test', verified, assertion, expiry],
            )
          ).rows[0].name,
      )
    await assert.rejects(signup('auth0|unverified', false), /Verified/)
    await assert.rejects(
      signup(
        'auth0|wrong-issuer',
        true,
        randomUUID(),
        Math.floor(Date.now() / 1000) + 30,
        'https://other.auth0.com/',
      ),
      /Issuer/,
    )
    await assert.rejects(
      signup('auth0|expired', true, randomUUID(), Math.floor(Date.now() / 1000) - 1),
      /assertion|expired|replayed/i,
    )
    const replay = randomUUID()
    await signup('auth0|replay', true, replay)
    await assert.rejects(signup('auth0|replay', true, replay), /replayed/)
    const disabled = await signup('auth0|disabled')
    await db.query(
      'UPDATE photo_security.app_principals SET enabled=false WHERE marker=(SELECT marker FROM gallery_access_objects WHERE name=$1)',
      [disabled],
    )
    await assert.rejects(signup('auth0|disabled'), /unavailable/)
    await asApp(disabled, async () =>
      assert.equal(
        (await db.query('SELECT photo_security.upload_account_allowed($1) AS allowed', [disabled]))
          .rows[0].allowed,
        false,
      ),
    )
    const owner = await signup('auth0|native-owner')
    const viewer = await signup('auth0|native-viewer')
    assert.equal(await signup('auth0|native-owner'), owner)
    assert.equal(
      (await db.query('SELECT * FROM folders WHERE owner_username=$1', [owner])).rowCount,
      0,
    )
    await db.query(
      "INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES(9001,1,'Private','native-private',$1,'PRIVATE'),(9002,2,'Gallery','native-gallery',$1,'GALLERY')",
      [owner],
    )
    await db.query(
      "INSERT INTO photos(photo_id,event_id,source_filename,ingest_status) VALUES(9001,9001,'private.jpg','READY'),(9002,9002,'gallery.jpg','READY')",
    )
    const person = randomUUID()
    await db.query('INSERT INTO face_people(person_id,owner_username,name) VALUES($1,$2,$3)', [
      person,
      owner,
      'Private person',
    ])
    const face = (
      await db.query(
        "INSERT INTO faces(photo_id,owner_username,source,created_by) VALUES(9002,$1,'manual',$1) RETURNING face_id",
        [owner],
      )
    ).rows[0].face_id
    await db.query(
      "INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES($1,$2,$3,'confirmed')",
      [face, person, owner],
    )
    await asApp(owner, async () => {
      assert.equal((await db.query('SELECT * FROM photo_security.person_counts()')).rowCount, 1)
      assert.equal(
        (await db.query('SELECT * FROM photo_security.person_counts($1)', [person])).rowCount,
        1,
      )
      assert.equal(
        (await db.query('SELECT people FROM photo_security.people_totals()')).rows[0].people,
        1,
      )
    })
    await asApp(viewer, async () => {
      assert.equal((await db.query('SELECT * FROM photo_security.person_counts()')).rowCount, 0)
      assert.equal(
        (await db.query('SELECT * FROM photo_security.person_counts($1)', [person])).rowCount,
        0,
      )
      assert.equal(
        (await db.query('SELECT people FROM photo_security.people_totals()')).rows[0].people,
        0,
      )
      assert.equal((await db.query('SELECT * FROM face_people')).rowCount, 0)
      assert.deepEqual((await db.query('SELECT event_id FROM events ORDER BY event_id')).rows, [
        { event_id: 9002 },
      ])
      assert.deepEqual((await db.query('SELECT photo_id FROM photos ORDER BY photo_id')).rows, [
        { photo_id: 9002 },
      ])
      assert.equal(
        (await db.query('SELECT photo_security.upload_account_allowed($1) AS allowed', [owner]))
          .rows[0].allowed,
        false,
      )
    })
    await asApp(owner, async () => {
      assert.equal(
        (await db.query('SELECT photo_security.upload_account_allowed($1) AS allowed', [owner]))
          .rows[0].allowed,
        true,
      )
      await db.query('SELECT photo_security.request_account_deletion()')
      assert.equal(
        (await db.query('SELECT photo_security.upload_account_allowed($1) AS allowed', [owner]))
          .rows[0].allowed,
        false,
      )
    })
    // Account deletion's application transaction also archives the owner's albums.
    await db.query('UPDATE events SET archived_account=true WHERE owner_username=$1', [owner])
    await asApp(viewer, async () => {
      assert.equal(
        (await db.query('SELECT * FROM events WHERE event_id IN (9001,9002)')).rowCount,
        0,
      )
      assert.equal(
        (await db.query('SELECT * FROM photos WHERE photo_id IN (9001,9002)')).rowCount,
        0,
      )
    })
    await assert.rejects(signup('auth0|native-owner'), /unavailable/)
    // Exercise the authority used by the extracted access commands with current
    // customer roles: replay is durable, revoked admins and the last admin fail closed.
    const adminA = await signup('auth0|native-admin-a')
    const adminB = await signup('auth0|native-admin-b')
    const adminRows = (
      await db.query('SELECT name,marker FROM gallery_access_objects WHERE name=ANY($1::text[])', [
        [adminA, adminB],
      ])
    ).rows
    const markerA = adminRows.find((row) => row.name === adminA).marker
    const markerB = adminRows.find((row) => row.name === adminB).marker
    await db.query(
      "INSERT INTO photo_security.app_memberships(marker,role_key) VALUES($1,'administrator'),($2,'administrator')",
      [markerA, markerB],
    )
    const permissionOperation = randomUUID()
    const changePermission = (actor, target, marker, action, value, operation = randomUUID()) =>
      asApp(actor, () =>
        db.query('SELECT photo_security.change_app_permission($1,$2,$3,$4,$5)', [
          operation,
          target,
          marker,
          action,
          value,
        ]),
      )
    await changePermission(adminA, adminB, markerB, 'revoke', 'administrator', permissionOperation)
    await changePermission(adminA, adminB, markerB, 'revoke', 'administrator', permissionOperation)
    assert.equal(
      (
        await db.query('SELECT * FROM photo_security.app_permission_audit WHERE operation_id=$1', [
          permissionOperation,
        ])
      ).rowCount,
      1,
    )
    await assert.rejects(
      changePermission(adminB, adminA, markerA, 'revoke', 'administrator'),
      /Access manager/,
    )
    await assert.rejects(
      changePermission(adminA, adminA, markerA, 'enabled', 'false'),
      /Self access/,
    )
    await assert.rejects(
      changePermission(viewer, adminA, markerA, 'enabled', 'false'),
      /Access manager/,
    )
    assert.equal(
      (
        await db.query(
          'SELECT app_owner AND enabled AS active FROM photo_security.native_app_identity($1)',
          [adminA],
        )
      ).rows[0].active,
      true,
    )
    console.log(
      'PASS: current Admin permission replay applied once; revoked/cross-user/self changes cannot remove the surviving Admin',
    )
    console.log(
      'PASS: native current registration, shared GALLERY/private isolation, no automatic folder, deleted-account visibility and upload-authority revocation',
    )
    console.log(
      'PASS: native PostgreSQL owner, viewer, read-only, sharing/revocation and role-boundary workflows; all test mutations rolled back',
    )
  },
  { vector: true },
)
