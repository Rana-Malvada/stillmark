import { type AlbumCaller, canManagePersonal } from '@/lib/albums/album-access'
import { ALBUM_READ_SQL } from '@/lib/albums/album-sql'
import { HttpError } from '@/lib/http'
import { pgQuery, pgQueryOne, pgTransaction } from '@/lib/postgres'
import { lockManagement } from '../database/management-lock'

export interface Folder {
  expanded: boolean
  ownerDisplayName?: string | null
  ownerUsername: string | null
  canSelect: boolean
  canEdit: boolean
  folderId: number
  folderName: string
  sortOrder: number
}

export async function listFolders(
  allowedIds: number[] | null,
  caller?: AlbumCaller,
): Promise<Folder[]> {
  const rows = caller
    ? await pgQuery(
        `SELECT f.*,
           COALESCE(
             (SELECT expanded FROM user_folder_state s
              WHERE s.folder_id=f.folder_id AND s.username=$1),
             true
           ) AS expanded
         FROM folders f
         WHERE $2::boolean
            OR f.owner_username=$1
            OR EXISTS(SELECT 1 FROM events e WHERE e.folder_id=f.folder_id AND ${ALBUM_READ_SQL})
         ORDER BY sort_order,folder_name`,
        [caller.username, caller.mainAdmin],
      )
    : await pgQuery(
        `SELECT f.*,true AS expanded FROM folders f WHERE $1::int[] IS NULL OR EXISTS(SELECT 1 FROM events e WHERE e.folder_id=f.folder_id AND e.event_id=ANY($1)) ORDER BY sort_order,folder_name`,
        [allowedIds],
      )
  // Only administrators need identities for the other-users section. Do not expose
  // account emails or internal IDs through the presentation label.
  const owners = new Map<string, string>()
  if (caller?.mainAdmin && rows.length) {
    const names = [...new Set(rows.map((r) => r.owner_username).filter(Boolean))]
    if (names.length) {
      const profiles = await pgQuery<{ name: string; display_name: string | null }>(
        "SELECT name,display_name FROM gallery_access_objects WHERE kind='user' AND name=ANY($1::text[]) UNION ALL SELECT name,display_name FROM deleted_accounts WHERE name=ANY($1::text[])",
        [names],
      )
      for (const profile of profiles) {
        const label = profile.display_name?.trim()
        owners.set(
          profile.name,
          label || (/^U_[a-f0-9]+$/i.test(profile.name) ? 'Member' : profile.name),
        )
      }
    }
  }
  return rows.map((r: Record<string, unknown>) => ({
    expanded: r.expanded !== false,
    ownerDisplayName: owners.get(String(r.owner_username)) ?? null,
    ownerUsername: r.owner_username == null ? null : String(r.owner_username),
    canSelect:
      !!caller &&
      canManagePersonal(caller) &&
      (r.owner_username === caller.username || (r.owner_username == null && caller.mainAdmin)),
    canEdit:
      !!caller &&
      canManagePersonal(caller) &&
      (caller.mainAdmin || r.owner_username === caller.username),
    folderId: Number(r.folder_id),
    folderName: String(r.folder_name),
    sortOrder: Number(r.sort_order ?? 0),
  }))
}

function cleanFolderName(name: string) {
  const cleaned = name.trim().replace(/\s+/gu, ' ')
  if (!cleaned) throw new HttpError(400, 'Folder name is required')
  return cleaned
}
async function checkFolderName(name: string, owner: string | null, except: number | null = null) {
  const duplicate = await pgQueryOne(
    `SELECT folder_id FROM folders
 WHERE owner_username IS NOT DISTINCT FROM $2::text
 AND lower(trim(regexp_replace(folder_name,'[[:space:]]+',' ','g')))=lower($1)
 AND ($3::int IS NULL OR folder_id<>$3) LIMIT 1`,
    [name, owner, except],
  )
  if (duplicate)
    throw new HttpError(409, 'A folder with this name already exists. Choose a different name.')
}
export async function createFolder(
  name: string,
  sortOrder = 0,
  owner: string | null = null,
): Promise<number> {
  return pgTransaction(async () => {
    await lockManagement()
    const cleaned = cleanFolderName(name)
    await checkFolderName(cleaned, owner)
    const r = await pgQueryOne<{ folder_id: number }>(
      `INSERT INTO folders(folder_name,sort_order,owner_username) VALUES($1,$2,$3) RETURNING folder_id`,
      [cleaned, sortOrder, owner],
    )
    return r!.folder_id
  })
}
export async function renameFolder(folderId: number, name: string): Promise<void> {
  await pgTransaction(async () => {
    await lockManagement()
    const folder = await pgQueryOne<{ owner_username: string | null }>(
      'SELECT owner_username FROM folders WHERE folder_id=$1 FOR UPDATE',
      [folderId],
    )
    if (!folder) throw new HttpError(404, 'Folder not found')
    const cleaned = cleanFolderName(name)
    await checkFolderName(cleaned, folder.owner_username, folderId)
    await pgQuery('UPDATE folders SET folder_name=$1 WHERE folder_id=$2', [cleaned, folderId])
  })
}

export async function deleteFolder(folderId: number): Promise<void> {
  await pgTransaction(async () => {
    // Move albums to uncategorized, then delete folder
    await pgQuery(`UPDATE events SET folder_id = NULL WHERE folder_id = $1`, [folderId])
    await pgQuery(`DELETE FROM folders WHERE folder_id = $1`, [folderId])
  })
}

export async function requireFolderWrite(id: number, c: AlbumCaller) {
  const f = await pgQueryOne<{ owner_username: string | null }>(
    'SELECT owner_username FROM folders WHERE folder_id=$1 FOR UPDATE',
    [id],
  )
  if (!f || !canManagePersonal(c) || (!c.mainAdmin && f.owner_username !== c.username))
    throw new HttpError(403, 'Folder owner permission required')
}

/**
 * Remembers whether a user keeps a folder expanded. The caller must already have checked
 * that the folder is visible to that user.
 */
export async function setFolderExpanded(
  username: string,
  folderId: number,
  expanded: boolean,
): Promise<void> {
  await pgQuery(
    `INSERT INTO user_folder_state(username,folder_id,expanded) VALUES($1,$2,$3)
   ON CONFLICT(username,folder_id) DO UPDATE SET expanded=EXCLUDED.expanded`,
    [username, folderId, expanded],
  )
}
