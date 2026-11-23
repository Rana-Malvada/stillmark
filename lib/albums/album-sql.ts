/**
 * The single SQL definition of who may read an album: its owner, the main
 * administrator, anyone when the album is shared with all signed-in users (GALLERY),
 * or a user it has been shared with. The events table must be aliased `e`.
 *
 * `user` and `admin` are the positions of the bound username and main-administrator
 * flag. Identity is only ever supplied as bound, server-verified values. Row-level
 * security enforces the same rule in the database; this predicate keeps queries
 * selective and makes the intent explicit. `canReadAlbum` in album-access.ts is the
 * same rule for a row that has already been loaded.
 */
export function albumReadSql(user: number, admin: number): string {
  return `(e.owner_username=$${user} OR $${admin}::boolean OR e.visibility='GALLERY' OR EXISTS (SELECT 1 FROM album_shares acl WHERE acl.event_id=e.event_id AND acl.username=$${user}))`
}

/** The rule with the username bound as `$1` and the main-administrator flag as `$2`. */
export const ALBUM_READ_SQL = albumReadSql(1, 2)
