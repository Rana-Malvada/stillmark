import { accountDisplayNames } from '@/lib/identity/account-display-name'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { pgQuery, pgQueryOne } from '../postgres'
import { albumCaller, albumMutation, canEditAlbum, requireAlbumAccess } from './album-access'
import { HttpError, integer } from '../http'

export const shareHeaders = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
}
export function tokenHash(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new HttpError(404, 'This link is unavailable or has expired.')
  return createHash('sha256').update(token).digest('hex')
}
export async function publicAlbum(token: string) {
  const link = await pgQueryOne<{
    id: string
    event_id: number
    event_name: string
    expires_at: Date
    allow_downloads: boolean
    include_location: boolean
    include_people: boolean
    photo_ids: number[] | null
  }>(
    `SELECT l.id,l.event_id,e.event_name,l.expires_at,l.allow_downloads,l.include_location,
       l.include_people,l.photo_ids
     FROM album_public_links l
     JOIN events e ON e.event_id=l.event_id
     WHERE token_hash=$1
     AND revoked_at IS NULL
     AND expires_at>now()
     AND l.owner_username=e.owner_username`,
    [tokenHash(token)],
  )
  if (!link) throw new HttpError(404, 'This link is unavailable or has expired.')
  return link
}
export async function createPublicLink(
  eventId: number,
  expires: string,
  downloads: boolean,
  includeLocation = false,
  includePeople = false,
  selectedPhotos?: unknown,
) {
  let photoIds: number[] | null = null
  if (selectedPhotos !== undefined) {
    if (!Array.isArray(selectedPhotos) || !selectedPhotos.length || selectedPhotos.length > 200)
      throw new HttpError(400, 'Choose 1–200 photos to share')
    photoIds = [...new Set(selectedPhotos.map((id) => integer(id, 'photo', 1, 2147483647)))]
  }
  const expiry = new Date(expires)
  if (
    !Number.isFinite(expiry.getTime()) ||
    expiry.getTime() <= Date.now() ||
    expiry.getTime() > Date.now() + 90 * 86400000
  )
    throw new HttpError(400, 'Choose an expiration in the next 90 days.')
  return albumMutation(async (caller) => {
    const album = await requireAlbumAccess(eventId, true, caller)
    if (photoIds) {
      const owned = await pgQuery(
        'SELECT photo_id FROM photos WHERE event_id=$1 AND photo_id=ANY($2::integer[]) FOR SHARE',
        [eventId, photoIds],
      )
      if (owned.length !== photoIds.length)
        throw new HttpError(
          409,
          'Some selected photos are no longer in this album. Select them again.',
        )
    }
    const token = randomBytes(32).toString('base64url')
    const id = randomUUID()
    await pgQuery(
      `INSERT INTO album_public_links(id,event_id,token_hash,owner_username,created_by,expires_at,allow_downloads,include_location,include_people,photo_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        eventId,
        tokenHash(token),
        album.owner_username,
        caller.username,
        expiry,
        downloads,
        includeLocation,
        includePeople,
        photoIds,
      ],
    )
    return { id, path: `/share/${token}`, expiresAt: expiry.toISOString() }
  })
}
export async function listPublicLinks(eventId: number) {
  await requireAlbumAccess(eventId, true)
  return pgQuery(
    `SELECT id,created_at,expires_at,allow_downloads,include_location,include_people,cardinality(photo_ids) AS selected_count,revoked_at FROM album_public_links WHERE event_id=$1 ORDER BY created_at DESC`,
    [eventId],
  )
}
export async function revokePublicLink(eventId: number, id: string) {
  return albumMutation(async (caller) => {
    await requireAlbumAccess(eventId, true, caller)
    await pgQuery(
      'UPDATE album_public_links SET revoked_at=COALESCE(revoked_at,now()) WHERE event_id=$1 AND id=$2',
      [eventId, id],
    )
  })
}

export async function listSharedLinks(owner = '', status = 'all', page = 0) {
  const caller = await albumCaller()
  const owners = caller.mainAdmin
    ? await pgQuery<{ username: string }>(
        `SELECT DISTINCT e.owner_username AS username FROM album_public_links l JOIN events e ON e.event_id=l.event_id ORDER BY username`,
      )
    : []
  const rows = await pgQuery<{
    id: string
    event_id: number
    event_name: string
    owner_username: string
    created_by: string
    created_at: Date
    expires_at: Date
    allow_downloads: boolean
    include_location: boolean
    include_people: boolean
    selected_count: number | null
    status: string
  }>(
    `
 WITH links AS (
 SELECT l.id,l.event_id,e.event_name,e.owner_username,l.created_by,l.created_at,l.expires_at,l.allow_downloads,l.include_location,l.include_people,cardinality(l.photo_ids) AS selected_count,
 CASE WHEN l.revoked_at IS NOT NULL THEN 'revoked' WHEN l.owner_username<>e.owner_username THEN 'invalidated' WHEN l.expires_at<=now() THEN 'expired' ELSE 'active' END AS status
 FROM album_public_links l JOIN events e ON e.event_id=l.event_id
 WHERE ($1::boolean OR e.owner_username=$2) AND ($3='' OR e.owner_username=$3)
 ) SELECT * FROM links WHERE ($4='all' OR status=$4) ORDER BY created_at DESC,id LIMIT 51 OFFSET $5`,
    [caller.mainAdmin, caller.username, caller.mainAdmin ? owner : '', status, page * 50],
  )
  const labels = await accountDisplayNames([
    ...owners.map((r) => r.username),
    ...rows.flatMap((r) => [r.owner_username, r.created_by]),
  ])
  return {
    links: rows.slice(0, 50).map((r) => ({
      ...r,
      owner_display_name: labels.get(r.owner_username),
      creator_display_name: labels.get(r.created_by),
      canRevoke: canEditAlbum(caller, r.owner_username),
    })),
    hasMore: rows.length > 50,
    owners: owners.map((r) => r.username),
    ownerLabels: Object.fromEntries(labels),
    canFilterOwners: caller.mainAdmin,
  }
}
