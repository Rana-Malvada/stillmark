import { cache } from 'react'
import { type CallerIdentity, getCallerIdentity } from '@/lib/identity/auth'
import { getDatabaseIdentity, pgQuery, pgQueryOne, pgTransaction } from '@/lib/postgres'
import { HttpError } from '@/lib/http'
import { lockManagement, lockManagementShared } from '../database/management-lock'
import { ALBUM_READ_SQL } from './album-sql'

export type AlbumCaller = CallerIdentity & { mainAdmin: boolean }
/** App Owner or a legacy server-side grant provides main access; ordinary admins never imply it. */
export const albumCaller = cache(async (): Promise<AlbumCaller> => {
  const caller = await getCallerIdentity()
  // Reuse the request's verified main-admin lookup instead of opening another transaction.
  const identity = await getDatabaseIdentity()
  return {
    ...caller,
    mainAdmin: identity.mainAdmin,
  }
})
export function canManagePersonal(caller: CallerIdentity) {
  return caller.canManagePersonal ?? caller.role !== 'admin_readonly'
}
/**
 * Who may read an album, for a row that is already loaded: its owner, the main
 * administrator, anyone when it is shared with all signed-in users, or a user it has
 * been shared with. `albumReadSql` in album-sql.ts is the same rule in SQL.
 */
export function canReadAlbum(
  caller: AlbumCaller,
  album: { owner_username: string; visibility: string; shared: boolean },
) {
  return (
    caller.mainAdmin ||
    album.owner_username === caller.username ||
    album.visibility === 'GALLERY' ||
    album.shared
  )
}
export function canEditAlbum(caller: AlbumCaller, owner: string) {
  return canManagePersonal(caller) && (caller.mainAdmin || caller.username === owner)
}
export async function accessibleAlbumIds(
  knownCaller = undefined as AlbumCaller | undefined,
): Promise<number[]> {
  const caller = knownCaller ?? (await albumCaller())
  const rows = await pgQuery<{ event_id: number }>(
    `SELECT e.event_id FROM events e WHERE ${ALBUM_READ_SQL}`,
    [caller.username, caller.mainAdmin],
  )
  return rows.map((row) => Number(row.event_id))
}
export async function requireAlbumAccess(id: number, write = false, knownCaller?: AlbumCaller) {
  const caller = knownCaller ?? (await albumCaller())
  const row = await pgQueryOne<{ owner_username: string; visibility: string; shared: boolean }>(
    `SELECT e.owner_username,e.visibility,EXISTS(SELECT 1 FROM album_shares s WHERE s.event_id=e.event_id AND s.username=$2) AS shared FROM events e WHERE e.event_id=$1`,
    [id, caller.username],
  )
  if (!row || !canReadAlbum(caller, row)) throw new HttpError(404, 'Album not found')
  if (write && !canEditAlbum(caller, row.owner_username))
    throw new HttpError(403, 'Album owner permission required')
  return { ...row, canEdit: canEditAlbum(caller, row.owner_username), caller }
}
export async function requirePhotoAccess(id: number, write = false, knownCaller?: AlbumCaller) {
  const caller = knownCaller ?? (await albumCaller())
  // Resolve the photo and its live album ACL in one indexed lookup. Both tables
  // retain RLS; mutations still call this inside their existing transaction.
  const row = await pgQueryOne<{
    owner_username: string
    visibility: string
    shared: boolean
    cover_photo_id: number | null
  }>(
    `SELECT e.owner_username,e.visibility,e.cover_photo_id,
 EXISTS(SELECT 1 FROM album_shares s WHERE s.event_id=e.event_id AND s.username=$2) AS shared
 FROM photos p JOIN events e ON e.event_id=p.event_id WHERE p.photo_id=$1`,
    [id, caller.username],
  )
  if (!row || !canReadAlbum(caller, row)) throw new HttpError(404, 'Photo not found')
  if (write && !canEditAlbum(caller, row.owner_username))
    throw new HttpError(403, 'Album owner permission required')
  return { ...row, canEdit: canEditAlbum(caller, row.owner_username), caller }
}
export async function requireUploadUser() {
  const caller = await albumCaller()
  if (!canManagePersonal(caller)) throw new HttpError(403, 'Read-only administrators cannot upload')
  return caller
}
export async function requireMainAdmin() {
  const caller = await albumCaller()
  if (!caller.mainAdmin) throw new HttpError(403, 'Main administrator permission required')
  return caller
}
/** Serialize authorization with moves, ownership changes and deletion. */
export async function albumMutation<T>(
  mutate: (caller: AlbumCaller) => Promise<T>,
  scope?: { eventIds?: number[]; photoIds?: number[] },
) {
  const caller = await albumCaller()
  if (!canManagePersonal(caller))
    throw new HttpError(403, 'Read-only administrators cannot modify content')
  return pgTransaction(async () => {
    if (scope) {
      const photoIds = [...new Set(scope.photoIds ?? [])]
      const eventIds = [...new Set(scope.eventIds ?? [])]
      if (
        (!photoIds.length && !eventIds.length) ||
        [...photoIds, ...eventIds].some((id) => !Number.isSafeInteger(id) || id < 1)
      )
        throw new Error('A scoped mutation requires valid album or photo IDs')
      // Match upload publication's lock order. Global catalog mutations retain
      // the exclusive barrier, so membership/ownership cannot change underneath us.
      await lockManagementShared()
      if (photoIds.length) {
        const rows = await pgQuery<{ photo_id: number; event_id: number }>(
          'SELECT photo_id,event_id FROM photos WHERE photo_id=ANY($1::int[])',
          [photoIds],
        )
        if (rows.length !== photoIds.length) throw new HttpError(404, 'Photos not found')
        eventIds.push(...rows.map((row) => Number(row.event_id)))
      }
      for (const id of [...new Set(eventIds)].sort((a, b) => a - b))
        await pgQuery('SELECT pg_advisory_xact_lock($1)', [id])
    } else {
      await lockManagement()
    }
    return mutate(caller)
  })
}
export async function requirePhotosAccess(ids: number[], write = false, knownCaller?: AlbumCaller) {
  const caller = knownCaller ?? (await albumCaller())
  const rows = await pgQuery<{
    photo_id: number
    owner_username: string
    visibility: string
    shared: boolean
  }>(
    `SELECT p.photo_id,e.owner_username,e.visibility,
 EXISTS(SELECT 1 FROM album_shares s WHERE s.event_id=e.event_id AND s.username=$2) AS shared
 FROM photos p JOIN events e ON e.event_id=p.event_id WHERE p.photo_id=ANY($1::int[])`,
    [ids, caller.username],
  )
  if (rows.length !== ids.length || rows.some((row) => !canReadAlbum(caller, row)))
    throw new HttpError(404, 'Photos not found')
  if (write && rows.some((row) => !canEditAlbum(caller, row.owner_username)))
    throw new HttpError(403, 'Album owner permission required')
}
export async function requireTrashAccess(ids: number[], caller: AlbumCaller) {
  const rows = await pgQuery<{ photo_id: number; owner_username: string }>(
    'SELECT photo_id,owner_username FROM photo_trash WHERE photo_id=ANY($1::int[])',
    [ids],
  )
  if (rows.length !== ids.length || rows.some((row) => !canEditAlbum(caller, row.owner_username)))
    throw new HttpError(404, 'Trash files not found')
}
