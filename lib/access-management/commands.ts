// Account mutations keep provider order and catalog transaction ownership here.
// Auth0 and Snowflake calls go through their existing independent adapters.
import { postgresPermissionsEnabled } from '../permission-authority'
import { appRoleKey, CUSTOMER_ROLES } from '../app-permissions'
import { HttpError } from '../http'
import { pgQuery, pgQueryOne, pgTransaction } from '../postgres'
import { identityControl } from '../identity/identity-control'
import {
  auth0Enabled,
  deleteAuth0User,
  ensureAuth0User,
  inspectAuth0User,
  setAuth0Password,
} from '../identity/auth0-management'
import { type AccessRequest, BASE_ROLES, identifier, type Managed, markerFor } from './contracts'
import { field, findObject, safeRole, safeUser, userGrants } from './authority'
import { lockManagement } from '../database/management-lock'

async function provision(
  request: Extract<AccessRequest, { action: 'createUser' | 'createRole' }>,
  id: string,
  actor: string,
) {
  const pgAuthority = postgresPermissionsEnabled()
  const kind = request.action === 'createUser' ? 'user' : 'role'
  if (pgAuthority && kind === 'user' && !auth0Enabled())
    throw new HttpError(503, 'Auth0 management must be configured to create app users')
  if (kind === 'user' && auth0Enabled() && (!('password' in request) || !request.password))
    throw new HttpError(400, 'An initial password is required for Auth0 login')
  let object = await pgQueryOne<Managed>(
    'SELECT * FROM gallery_access_objects WHERE kind=$1 AND name=$2',
    [kind, request.name],
  )
  if (object?.deleting)
    throw new HttpError(409, 'Deletion is in progress; finish it before recreating this user')
  if (object && object.marker !== id)
    throw new HttpError(409, 'This name is already registered; choose another name')
  if (!object) {
    if (!pgAuthority && (await findObject(kind, request.name)))
      throw new HttpError(
        409,
        'This name already exists in Snowflake; existing accounts are never adopted or replaced',
      )
    const rows = await pgQuery<Managed>(
      `INSERT INTO gallery_access_objects(kind,name,marker,profile,display_name,email,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        kind,
        request.name,
        id,
        request.action === 'createRole' ? request.profile : null,
        request.displayName,
        request.action === 'createUser' ? request.email : null,
        actor,
      ],
    )
    object = rows[0]
  }
  const existing = pgAuthority ? null : await findObject(kind, request.name)
  if (existing && field(existing, 'comment') !== markerFor(object.marker))
    throw new HttpError(409, 'This name is now used by a different Snowflake object')
  if (!pgAuthority && !existing) {
    if (request.action === 'createUser') {
      // Passwords are optional; gallery access is always assigned separately.
      await identityControl('createUser', {
        name: request.name,
        displayName: request.displayName,
        email: request.email,
        marker: id,
        ...(!auth0Enabled() && request.password ? { password: request.password } : {}),
      })
    }
  }
  // Repair interrupted provisioning before enabling the Auth0 login or marking ready.
  if (request.action === 'createUser' && existing)
    await identityControl('restrictUser', { name: request.name })
  if (request.action === 'createUser' && auth0Enabled()) {
    const auth0Id = await ensureAuth0User(object, request.password!)
    await pgQuery(
      "UPDATE gallery_access_objects SET auth0_user_id=$2 WHERE kind='user' AND name=$1 AND marker=$3",
      [request.name, auth0Id, object.marker],
    )
  }
  if (request.action === 'createRole' && !pgAuthority)
    await identityControl('createRole', {
      name: request.name,
      marker: id,
      profile: request.profile,
    })
  await pgQuery("UPDATE gallery_access_objects SET state='ready' WHERE kind=$1 AND name=$2", [
    kind,
    request.name,
  ])
  if (pgAuthority) {
    await pgQuery(
      request.action === 'createUser'
        ? 'SELECT photo_security.register_app_principal($1,$2::uuid)'
        : 'SELECT photo_security.register_app_role($1,$2::uuid)',
      [request.name, object.marker],
    )
    return {
      message:
        request.action === 'createUser'
          ? 'App user created. Assign a gallery role to enable access.'
          : 'App role created.',
    }
  }
  return {
    message:
      request.action === 'createUser'
        ? auth0Enabled()
          ? 'User created in Auth0 and Snowflake. Assign a gallery role, then share the username, Auth0 password and photo app address privately.'
          : request.password
            ? 'User created with a password. Assign a gallery role, then share the username and password privately.'
            : 'User created. Assign a gallery role, then generate a login setup link.'
        : 'Role created.',
  }
}
async function deleteManagedUser(
  actor: string,
  request: Extract<AccessRequest, { action: 'deleteUser' }>,
  retrying: boolean,
) {
  if (
    await pgQueryOne('SELECT username FROM gallery_main_admins WHERE username=$1', [request.name])
  )
    throw new HttpError(403, 'Main administrators cannot be deleted through the app')
  if (request.confirmation !== request.name)
    throw new HttpError(400, 'Type the exact username to confirm deletion')
  const object = await pgQueryOne<Managed>(
    'SELECT * FROM gallery_access_objects WHERE kind=$1 AND name=$2',
    ['user', request.name],
  )
  const pgAuthority = postgresPermissionsEnabled()
  const live = pgAuthority ? null : await findObject('user', request.name)
  if (!object) {
    if (!retrying || live)
      throw new HttpError(409, 'This user is not managed by this app or has been recreated')
  } else {
    if (object.marker !== request.marker)
      throw new HttpError(409, 'This user has been recreated. Refresh access before deleting it')
    if (live || pgAuthority) {
      // Recheck ownership marker and non-gallery grants immediately before deletion.
      const checked = await safeUser(request.name, true)
      if (
        checked.roles.includes(BASE_ROLES.app_owner) ||
        checked.roles.includes(CUSTOMER_ROLES.administrator)
      )
        throw new HttpError(403, 'Remove the App Owner role before deleting this user')
    }
    // Resolve a surviving administrator before any external login is removed.
    const recipient = async () => {
      const main = pgAuthority
        ? await pgQueryOne<{ username: string }>(
            `SELECT i.name AS username FROM gallery_access_objects o
             CROSS JOIN LATERAL photo_security.native_app_identity(o.name) i
             WHERE o.kind='user' AND o.name<>$1 AND i.enabled AND i.app_owner
             ORDER BY (o.name=$2) DESC,o.name LIMIT 1`,
            [request.name, actor],
          )
        : await pgQueryOne<{ username: string }>(
            'SELECT username FROM gallery_main_admins ORDER BY username LIMIT 1',
          )
      if (!main) throw new HttpError(409, 'An active Admin must be assigned before deleting users')
      return main
    }
    await recipient()
    if (auth0Enabled() || object.auth0_user_id) {
      // Verify both ownership boundaries before disabling either account. Keep the registry until both deletions finish.
      await inspectAuth0User(object)
      await pgQuery(
        "UPDATE gallery_access_objects SET deleting=true WHERE kind='user' AND name=$1 AND marker=$2",
        [request.name, request.marker],
      )
      if (live) await identityControl('disableUser', { name: request.name, marker: request.marker })
      await deleteAuth0User(object)
    }
    if (live) {
      await identityControl('deleteUser', { name: request.name, marker: request.marker })
    }
    await pgTransaction(async () => {
      await lockManagement()
      await recipient()
      await pgQuery(
        `INSERT INTO deleted_accounts(name,marker,display_name,email,joined_at,deleted_by)
         SELECT name,marker,display_name,email,created_at,$3 FROM gallery_access_objects
         WHERE kind='user' AND name=$1 AND marker=$2
         ON CONFLICT(name) DO NOTHING`,
        [request.name, request.marker, actor],
      )
      // Keep the original owner. Archive visibility and revoke both sharing mechanisms
      // in the same transaction as registry removal, including retries after Auth0 deletion.
      await pgQuery(
        "UPDATE events SET archived_account=true,visibility='PRIVATE' WHERE owner_username=$1",
        [request.name],
      )
      await pgQuery(
        'DELETE FROM album_shares WHERE username=$1 OR event_id IN (SELECT event_id FROM events WHERE owner_username=$1)',
        [request.name],
      )
      await pgQuery(
        'UPDATE album_public_links SET revoked_at=COALESCE(revoked_at,now()) WHERE event_id IN (SELECT event_id FROM events WHERE owner_username=$1)',
        [request.name],
      )
      await pgQuery('DELETE FROM upload_sessions WHERE owner=$1', [request.name])
      await pgQuery(
        "DELETE FROM gallery_access_objects WHERE kind='user' AND name=$1 AND marker=$2",
        [request.name, request.marker],
      )
    })
  }
  return {
    message: pgAuthority
      ? 'App user and linked Auth0 login deleted; content is preserved under Deleted accounts.'
      : 'User deleted. Linked Auth0 login and Snowflake access were removed; content is preserved under Deleted accounts.',
  }
}

export async function executeAccessCommand(
  actor: string,
  id: string,
  request: AccessRequest,
  retrying: boolean,
) {
  let response: Record<string, unknown>
  if (request.action === 'createUser' || request.action === 'createRole')
    response = await provision(request, id, actor)
  else if (request.action === 'deleteUser') {
    if (request.name === identifier(actor))
      throw new HttpError(403, 'You cannot delete your own account')
    response = await deleteManagedUser(actor, request, retrying)
  } else {
    if (request.name === identifier(actor))
      throw new HttpError(403, 'Another administrator must change your account access')
    const user = await safeUser(request.name)
    if (request.action === 'setUserEnabled') {
      await pgQuery('SELECT photo_security.change_app_permission($1::uuid,$2,$3::uuid,$4,$5)', [
        id,
        request.name,
        user.row.marker,
        'enabled',
        String(request.enabled),
      ])
      response = {
        message: request.enabled
          ? 'App access enabled.'
          : 'App access disabled. New requests are denied.',
      }
    } else if (request.action === 'setPassword') {
      if (auth0Enabled() || user.row.auth0_user_id) {
        if (user.row.auth0_user_id) await setAuth0Password(user.row, request.password)
        else {
          const recovered = await inspectAuth0User(user.row)
          const auth0Id = await ensureAuth0User(user.row, request.password)
          await pgQuery(
            "UPDATE gallery_access_objects SET auth0_user_id=$2 WHERE kind='user' AND name=$1 AND marker=$3",
            [request.name, auth0Id, user.row.marker],
          )
          // Also covers a previous successful Auth0 create followed by failed registry persistence.
          if (recovered)
            await setAuth0Password({ ...user.row, auth0_user_id: auth0Id }, request.password)
        }
        response = {
          message:
            'Auth0 login password set. Share the username or email and password privately; choose Personal Photos on the app login screen.',
        }
      } else {
        await identityControl('setPassword', { name: request.name, password: request.password })
        response = {
          message:
            'Password set. Share it privately with the user; they can open the photo app directly. Snowflake authentication policies still apply.',
        }
      }
    } else if (request.action === 'setupLink') {
      if (auth0Enabled() || user.row.auth0_user_id)
        throw new HttpError(
          409,
          'Use Set password for Auth0 login. Snowflake password setup links do not change Auth0 credentials.',
        )
      if (!user.roles.length)
        throw new HttpError(409, 'Assign a gallery role before generating a login setup link')
      const rows = await identityControl('setupLink', { name: request.name })
      const url = String(
        rows[0]?.['password reset link'] ??
          rows[0]?.['PASSWORD RESET LINK'] ??
          rows[0]?.status ??
          rows[0]?.STATUS ??
          '',
      )
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new HttpError(502, 'Snowflake did not return a password setup link')
      }
      if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.snowflakecomputing.com'))
        throw new HttpError(502, 'Snowflake returned an unexpected password setup address')
      response = {
        message: 'Share this one-time link privately. It expires after four hours.',
        setupUrl: url,
      }
    } else {
      await safeRole(request.role)
      if (postgresPermissionsEnabled()) {
        await pgQuery('SELECT photo_security.change_app_permission($1::uuid,$2,$3::uuid,$4,$5)', [
          id,
          request.name,
          user.row.marker,
          request.action === 'grantRole' ? 'grant' : 'revoke',
          appRoleKey(request.role),
        ])
      } else {
        await identityControl(request.action, { name: request.name, role: request.role })
        const remaining = (await userGrants(request.name))
          .filter((r) => field(r, 'granted_on') === 'ROLE' && field(r, 'privilege') === 'USAGE')
          .map((r) => String(field(r, 'role')))
          .filter((r) => r !== 'PUBLIC')
          .sort()
        // Default role must remain usable after removing a prior default grant.
        await identityControl('setDefaultRole', {
          name: request.name,
          role: remaining[0] ?? 'PUBLIC',
        })
      }
      response = {
        message:
          request.action === 'grantRole'
            ? 'Gallery role assigned.'
            : 'Gallery role removed. New requests use the updated permissions.',
      }
    }
  }
  return response
}
