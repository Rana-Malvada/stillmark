import { databaseContext } from '../database/database-context'
import { getDatabaseIdentity, pgLookupMedia, pgQueryOne } from '../postgres'
import { albumReadSql } from '../albums/album-sql'
import { flagOn } from '../flags'

// Separate branches allow the existing photo path indexes and the playback indexes
// to locate candidates before applying both RLS and the live album ACL.
export const mediaLookupSql = `WITH candidate AS MATERIALIZED (
 SELECT photo_id,event_id,original_stage_path,file_size_bytes,thumbnail_stage_path FROM photos WHERE original_stage_path=$1
 UNION ALL
 SELECT photo_id,event_id,original_stage_path,file_size_bytes,thumbnail_stage_path FROM photos WHERE display_stage_path=$1
 UNION ALL
 SELECT photo_id,event_id,original_stage_path,file_size_bytes,thumbnail_stage_path FROM photos WHERE thumbnail_stage_path=$1
 UNION ALL
 SELECT p.photo_id,p.event_id,p.original_stage_path,p.file_size_bytes,p.thumbnail_stage_path
 FROM video_playback v JOIN photos p ON p.photo_id=v.photo_id AND p.original_stage_path=v.original_path
 WHERE v.status='ready' AND v.stage_path=$1
 UNION ALL
 SELECT p.photo_id,p.event_id,p.original_stage_path,p.file_size_bytes,p.thumbnail_stage_path
 FROM video_rendition_paths r JOIN video_playback v ON v.photo_id=r.photo_id
 JOIN photos p ON p.photo_id=v.photo_id AND p.original_stage_path=v.original_path
 WHERE v.status='ready' AND r.stage_path=$1
)
SELECT c.* FROM candidate c JOIN events e ON e.event_id=c.event_id
WHERE ${albumReadSql(2, 3)}
LIMIT 1`

type MediaRow = {
  photo_id: number
  event_id: number
  original_stage_path: string
  thumbnail_stage_path: string | null
  file_size_bytes: number
}
export async function lookupMedia(path: string): Promise<MediaRow | null> {
  if (flagOn('PG_MEDIA_LOOKUP_FUNCTION_ENABLED')) {
    const { requireAuth } = await import('../identity/auth')
    const principal = await requireAuth()
    const ctx = databaseContext.getStore()
    const prefetched = ctx?.kind === 'request' ? ctx.gatewayMediaLookup : undefined
    // Reuse only the exact path and verified principal within this request.
    if (prefetched?.path === path && prefetched.username === principal.username)
      return prefetched.row as MediaRow | null
    // First prove ordinary access using the authenticated principal and live RLS/ACL.
    // No elevated capability is assumed from the ingress role or a cached image URL.
    const ordinary = await pgLookupMedia<MediaRow>(path, {
      username: principal.username,
      mainAdmin: false,
      adminRead: false,
      adminWrite: false,
      canWrite: false,
      accessManager: false,
    })
    if (ordinary) return ordinary
    // Admin-only visibility still requires the original verified role resolution.
    const caller = await getDatabaseIdentity()
    return caller.mainAdmin ? pgLookupMedia<MediaRow>(path, caller) : null
  }
  const caller = await getDatabaseIdentity()
  return pgQueryOne<MediaRow>(mediaLookupSql, [path, caller.username, caller.mainAdmin])
}
