/** Wire contracts shared by the album-access and public-link management screens. */
export type AlbumSharingData = {
  owner: string
  ownerDisplayName?: string
  visibility: 'PRIVATE' | 'GALLERY' | null
  canEdit: boolean
  mainAdmin: boolean
  shares: { username: string; displayName?: string }[]
}
export type SharedLinkEntry = {
  id: string
  event_id: number
  event_name: string
  owner_display_name?: string
  creator_display_name?: string
  owner_username: string
  created_by: string
  created_at: string
  expires_at: string
  allow_downloads: boolean
  include_location: boolean
  include_people: boolean
  selected_count: number | null
  status: 'active' | 'expired' | 'revoked' | 'invalidated'
  canRevoke: boolean
}
export type SharedLinksData = {
  links: SharedLinkEntry[]
  hasMore: boolean
  owners: string[]
  ownerLabels?: Record<string, string>
  canFilterOwners: boolean
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const optionalText = (value: unknown) => value === undefined || text(value)
const timestamp = (value: unknown) => text(value) && Number.isFinite(Date.parse(value))
export function isAlbumSharing(value: unknown): value is AlbumSharingData {
  return (
    record(value) &&
    text(value.owner) &&
    optionalText(value.ownerDisplayName) &&
    (value.visibility === null ||
      value.visibility === 'PRIVATE' ||
      value.visibility === 'GALLERY') &&
    typeof value.canEdit === 'boolean' &&
    typeof value.mainAdmin === 'boolean' &&
    Array.isArray(value.shares) &&
    value.shares.every(
      (share) => record(share) && text(share.username) && optionalText(share.displayName),
    )
  )
}
export function isSharedLinks(value: unknown): value is SharedLinksData {
  return (
    record(value) &&
    typeof value.hasMore === 'boolean' &&
    typeof value.canFilterOwners === 'boolean' &&
    Array.isArray(value.owners) &&
    value.owners.every(text) &&
    (value.ownerLabels === undefined ||
      (record(value.ownerLabels) && Object.values(value.ownerLabels).every(text))) &&
    Array.isArray(value.links) &&
    value.links.length <= 50 &&
    value.links.every(
      (link) =>
        record(link) &&
        ['id', 'event_name', 'owner_username', 'created_by'].every((key) => text(link[key])) &&
        Number.isSafeInteger(link.event_id) &&
        Number(link.event_id) > 0 &&
        optionalText(link.owner_display_name) &&
        optionalText(link.creator_display_name) &&
        timestamp(link.created_at) &&
        timestamp(link.expires_at) &&
        ['allow_downloads', 'include_location', 'include_people', 'canRevoke'].every(
          (key) => typeof link[key] === 'boolean',
        ) &&
        (link.selected_count === null ||
          (Number.isSafeInteger(link.selected_count) && Number(link.selected_count) >= 0)) &&
        typeof link.status === 'string' &&
        ['active', 'expired', 'revoked', 'invalidated'].includes(link.status),
    )
  )
}
export function isSharingChanged(value: unknown): value is { ok: true } {
  return record(value) && value.ok === true
}

export type PublicLinkInfo = {
  id: string
  created_at: string
  expires_at: string
  allow_downloads: boolean
  include_location: boolean
  include_people: boolean
  selected_count: number | null
  revoked_at: string | null
}
export function isPublicLinks(value: unknown): value is PublicLinkInfo[] {
  return (
    Array.isArray(value) &&
    value.every(
      (link) =>
        record(link) &&
        text(link.id) &&
        timestamp(link.created_at) &&
        timestamp(link.expires_at) &&
        (link.revoked_at === null || timestamp(link.revoked_at)) &&
        ['allow_downloads', 'include_location', 'include_people'].every(
          (key) => typeof link[key] === 'boolean',
        ) &&
        (link.selected_count === null ||
          (Number.isSafeInteger(link.selected_count) && Number(link.selected_count) >= 0)),
    )
  )
}
export function isPublicLinkCreated(
  value: unknown,
): value is { id: string; path: string; expiresAt: string } {
  return (
    record(value) &&
    text(value.id) &&
    timestamp(value.expiresAt) &&
    text(value.path) &&
    /^\/share\/[A-Za-z0-9_-]{43}$/.test(value.path)
  )
}
