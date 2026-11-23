import { pgQueryOne } from './postgres'

/** RLS restricts album rows. The all-scope rows are visible only to the main admin. */
export const galleryStatisticsSql = `SELECT
 coalesce(sum(total_photos),0)::text AS total_photos,
 coalesce(sum(total_videos),0)::text AS total_videos,
 coalesce(sum(photos_with_ai),0)::text AS photos_with_ai,
 coalesce(sum(photos_without_ai),0)::text AS photos_without_ai,
 coalesce(sum(photos_failed),0)::text AS photos_failed,
 coalesce(sum(in_search),0)::text AS in_search,
 coalesce(sum(photo_updates),0)::text AS pending_photo_updates,
 coalesce(sum(album_updates),0)::text AS pending_album_updates,
 coalesce(sum(photo_removals),0)::text AS pending_photo_removals,
 coalesce(sum(album_removals),0)::text AS pending_album_removals,
 coalesce(sum(photo_updates+album_updates),0)::text AS pending_sync,
 coalesce(sum(photo_removals+album_removals),0)::text AS pending_search_removals,
 statement_timestamp() AS observed_at
 FROM gallery_statistics WHERE scope=CASE WHEN photo_security.flag('main_admin') THEN 'all' ELSE 'album' END`

export async function readGalleryStatistics() {
  const row = await pgQueryOne<Record<string, string | Date>>(galleryStatisticsSql)
  if (!row) throw Error('Statistics unavailable')
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (key === 'observed_at') return [key, value]
      const integer = BigInt(String(value))
      if (integer < BigInt(0)) throw Error('Invalid statistics counter')
      // Keep numeric compatibility at current scale; never round an oversized count.
      return [
        key,
        integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString(),
      ]
    }),
  )
}
