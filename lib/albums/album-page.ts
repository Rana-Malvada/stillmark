import { accountDisplayNames } from '@/lib/identity/account-display-name'
import { pgPageRows } from '../database/postgres-page-rows'
import { pgQuery, pgReadIdentity } from '@/lib/postgres'
import { ALBUM_READ_SQL } from '@/lib/albums/album-sql'
import { type AlbumCaller } from '@/lib/albums/album-access'
import { mapEvent } from '@/lib/albums/events'
import { HttpError } from '@/lib/http'

export const ALBUM_PAGE_SIZE = 96
export function albumCursor(value: string | null): [number, number] | null {
  if (!value) return null
  if (value.length > 128) throw new HttpError(400, 'Invalid album cursor')
  try {
    const v = JSON.parse(Buffer.from(value, 'base64url').toString())
    if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isSafeInteger) || v[1] < 1)
      throw Error()
    return v as [number, number]
  } catch {
    throw new HttpError(400, 'Invalid album cursor')
  }
}
export async function albumPage(c: AlbumCaller, params: URLSearchParams) {
  const result = await pgReadIdentity(
    c,
    async () => {
      const cursor = albumCursor(params.get('cursor'))
      const mine = params.get('scope') === 'mine'
      const section = params.get('section')
      const folder = params.get('folder')
      if (section && !['mine', 'collection', 'personal', 'others', 'deleted'].includes(section))
        throw new HttpError(400, 'Invalid album section')
      if (folder !== null && folder !== 'none' && !/^[1-9][0-9]*$/.test(folder))
        throw new HttpError(400, 'Invalid album folder')
      const folderId = folder && folder !== 'none' ? Number(folder) : null
      if (folderId !== null && !Number.isSafeInteger(folderId))
        throw new HttpError(400, 'Invalid album folder')
      const values = [c.username, c.mainAdmin, mine]
      const where = `${ALBUM_READ_SQL} AND (NOT $3::boolean OR e.owner_username=$1)`
      // These bounded page lookups are OLTP reads; compiling an RLS-heavy plan
      // can cost more than executing it. The setting ends with this transaction.
      const pageSql = `WITH page AS MATERIALIZED (
 SELECT e.event_id,e.archived_account,e.owner_username,e.sort_order,e.event_name,e.event_month,e.event_year,e.cover_photo_id,e.photo_count,e.visibility,e.location,e.folder_id
 FROM events e WHERE ${where}
 AND ($6::text IS NULL OR (CASE WHEN e.archived_account THEN 'deleted' WHEN $3::boolean THEN 'mine' WHEN e.visibility='GALLERY' THEN 'collection' WHEN e.owner_username=$1 THEN 'personal' ELSE 'others' END)=$6)
 AND ($7::boolean=false OR e.folder_id IS NOT DISTINCT FROM $8::int)
 AND ($4::int IS NULL OR (COALESCE(e.sort_order,0),e.event_id)>($4,$5))
 ORDER BY COALESCE(e.sort_order,0),e.event_id LIMIT ${ALBUM_PAGE_SIZE + 1}
 ) SELECT e.*,p.thumbnail_stage_path,(SELECT d.display_name FROM deleted_accounts d WHERE d.name=e.owner_username) AS owner_display_name FROM page e
 LEFT JOIN LATERAL (SELECT thumbnail_stage_path FROM photos
   WHERE photo_id=e.cover_photo_id AND event_id=e.event_id LIMIT 1) p ON true
 ORDER BY COALESCE(e.sort_order,0),e.event_id`
      const pageParams = [
        ...values,
        cursor?.[0] ?? null,
        cursor?.[1] ?? null,
        section,
        folder !== null,
        folderId,
      ]
      const includeGroups =
        params.get('groups') !== 'false' && !cursor && folder === null && section === null
      type Group = { section: string; folder_id: number | null; albums: number; photos: number }
      let rows: Record<string, unknown>[]
      let groups: Group[] | undefined
      if (includeGroups) {
        // Both reads use the same RLS identity and one statement snapshot. Avoid
        // another network round trip while holding the database connection.
        const [result] = await pgQuery<{ page_rows: Record<string, unknown>[]; groups: Group[] }>(
          `WITH page_rows AS (${pageSql}), grouped AS (
            SELECT CASE WHEN e.archived_account THEN 'deleted'
              WHEN $3::boolean THEN 'mine'
              WHEN e.visibility='GALLERY' THEN 'collection'
              WHEN e.owner_username=$1 THEN 'personal'
              ELSE 'others' END AS section,
              e.folder_id,count(*)::int AS albums,COALESCE(sum(e.photo_count),0)::float8 AS photos
            FROM events e WHERE ${where} GROUP BY section,e.folder_id
          ) SELECT COALESCE((SELECT json_agg(page_rows ORDER BY COALESCE(sort_order,0),event_id) FROM page_rows),'[]'::json) AS page_rows,
                   COALESCE((SELECT json_agg(grouped) FROM grouped),'[]'::json) AS groups`,
          pageParams,
        )
        if (!Array.isArray(result?.page_rows) || !Array.isArray(result?.groups))
          throw new Error('Invalid album page result')
        rows = result.page_rows
        groups = result.groups
      } else {
        rows = await pgPageRows<Record<string, unknown>>(pageSql, pageParams)
      }
      const more = rows.length > ALBUM_PAGE_SIZE
      const items = rows.slice(0, ALBUM_PAGE_SIZE).map(mapEvent)
      const last = items.at(-1)
      return {
        items,
        nextCursor:
          more && last
            ? Buffer.from(JSON.stringify([last.sortOrder, last.eventId])).toString('base64url')
            : null,
        groups,
      }
    },
    { disableJit: true, singleQuery: true },
  )
  if (c.mainAdmin && result.items.length) {
    const names = await accountDisplayNames(result.items.map((item) => item.ownerUsername))
    result.items = result.items.map((item) => ({
      ...item,
      ownerDisplayName: names.get(item.ownerUsername) || item.ownerDisplayName,
    }))
  }
  return result
}
