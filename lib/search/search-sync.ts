import { searchSyncByteBudget, sqlByteBatches } from '../sql-byte-batches'
import { acknowledgeEventsSql, acknowledgePhotosSql, claimPhotosSql } from './search-sync-ack'
import { objects } from '../../config/deployment.mjs'
import { databaseSignal, withServiceDatabase } from '../database/database-context'
import { costWork, ownerWeights } from '../costs/cost-work'
import { pgQuery, pgQueryOne, withAdvisoryLock } from '@/lib/postgres'
import { querySnowflake, querySnowflakeLongRunning } from '@/lib/snowflake'
import { enqueueFullSearchRepair } from './search-repair'

const SEARCH_SERVICES = [objects.photoSearch, objects.eventSearch] as const
const SF_TABLE = objects.photoSearchTable
const SF_EVENT_TABLE = objects.eventSearchTable

interface Queued {
  id: number
  revision: string
}
async function syncPhotos(): Promise<{ synced: number }> {
  const queue = await pgQuery<Queued>(claimPhotosSql)
  if (!queue.length) return { synced: 0 }
  const ids = queue.map((row) => row.id)
  const photos = await pgQuery(PHOTO_SELECT_SQL + ' AND p.photo_id=ANY($1::int[])', [ids])
  for (const batch of sqlByteBatches(photos, buildValueRow, buildMergeSql, searchSyncByteBudget()))
    await costWork(
      'search_indexing',
      ownerWeights(
        batch.records.map((p) => ({ ...p, cost_units: Buffer.byteLength(photoSearchText(p)) })),
      ),
      () => querySnowflakeLongRunning(batch.sql, { maxWaitMs: 120_000, signal: databaseSignal() }),
      'PHOTO_SEARCH_SERVICE',
    )
  const live = new Set(photos.map((p) => Number(p.photo_id)))
  const deleted = ids.filter((id) => !live.has(id))
  if (deleted.length)
    await querySnowflake(
      `DELETE FROM ${SF_TABLE} WHERE PHOTO_ID IN (${deleted.map(() => '?').join(',')})`,
      { binds: deleted },
    )
  await pgQuery(acknowledgePhotosSql, [ids, queue.map((row) => row.revision), [...live]])
  return { synced: photos.length }
}

const PHOTO_SELECT_SQL = `SELECT p.photo_id, p.event_id, p.source_filename, p.display_stage_path, p.thumbnail_stage_path,
        (SELECT ocr_text FROM search_enrichment se WHERE se.photo_id=p.photo_id AND se.status='completed' AND se.source_path=p.original_stage_path) AS ocr_text,
        p.date_taken, p.camera_make, p.camera_model, p.lens_model, p.software, p.artist,
        p.focal_length, p.aperture, p.shutter_speed, p.iso, p.flash_used,
        p.white_balance, p.exposure_mode, p.scene_capture_type,
        p.latitude, p.longitude, p.altitude,
        p.country, p.region, p.city, p.location_name,
        p.iptc_keywords, p.iptc_headline, p.caption, p.user_tags,
        p.ai_description, p.ai_tags, p.favorite, p.rating, p.updated_at,
        (SELECT search_text FROM video_analyses a WHERE a.photo_id=p.photo_id AND a.status='completed' ORDER BY created_at DESC LIMIT 1) AS video_analysis_text,
        e.owner_username, e.event_name, e.event_month, e.event_year, e.location AS event_location
 FROM photos p
 JOIN events e ON e.event_id = p.event_id
 WHERE p.ingest_status = 'READY' AND p.display_stage_path IS NOT NULL`

export function photoSearchText(p: Record<string, unknown>): string {
  const dateTaken = p.date_taken ? new Date(String(p.date_taken)) : null
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ]
  const dateText =
    dateTaken && !isNaN(dateTaken.getTime())
      ? `${monthNames[dateTaken.getMonth()]} ${dateTaken.getFullYear()}`
      : p.event_month && p.event_year
        ? `${monthNames[Number(p.event_month) - 1]} ${p.event_year}`
        : null
  const searchParts = [
    p.source_filename,
    p.event_name,
    p.event_location,
    dateText,
    p.caption,
    p.iptc_headline,
    p.country,
    p.region,
    p.city,
    p.location_name,
    p.camera_make,
    p.camera_model,
    p.lens_model,
    p.artist,
    p.date_taken
      ? `Capture date: ${new Date(String(p.date_taken)).toISOString().slice(0, 10)}`
      : null,
    p.latitude != null && p.longitude != null ? `GPS: ${p.latitude}, ${p.longitude}` : null,
    Array.isArray(p.iptc_keywords) ? p.iptc_keywords.join(', ') : null,
    p.ai_description,
    p.video_analysis_text,
    p.ocr_text,
    Array.isArray(p.user_tags) ? p.user_tags.join(', ') : null,
    Array.isArray(p.ai_tags) ? p.ai_tags.join(', ') : null,
  ].filter(Boolean)
  return searchParts.join(' | ')
}

function buildValueRow(p: Record<string, unknown>): string {
  const searchText = photoSearchText(p)
  return `(${esc(p.photo_id)}, ${esc(p.event_id)}, ${escStr(p.source_filename)}, ${escStr(p.display_stage_path)}, ${escStr(p.thumbnail_stage_path)},
           ${escTs(p.date_taken)}, ${escStr(p.camera_make)}, ${escStr(p.camera_model)}, ${escStr(p.lens_model)}, ${escStr(p.software)}, ${escStr(p.artist)},
           ${escStr(p.focal_length)}, ${escStr(p.aperture)}, ${escStr(p.shutter_speed)}, ${esc(p.iso)}, ${escBool(p.flash_used)},
           ${escStr(p.white_balance)}, ${escStr(p.exposure_mode)}, ${escStr(p.scene_capture_type)},
           ${esc(p.latitude)}, ${esc(p.longitude)}, ${esc(p.altitude)},
           ${escStr(p.country)}, ${escStr(p.region)}, ${escStr(p.city)}, ${escStr(p.location_name)},
           ${escStr(Array.isArray(p.iptc_keywords) ? p.iptc_keywords.join(', ') : null)}, ${escStr(p.iptc_headline)}, ${escStr(p.caption)},
           ${escStr(p.ai_description)}, ${escStr(Array.isArray(p.ai_tags) ? p.ai_tags.join(', ') : null)},
           ${escBool(p.favorite)}, ${esc(p.rating)}, ${escStr(searchText)}, ${escTs(p.updated_at)},
           ${escStr(p.event_name)}, ${esc(p.event_month)}, ${esc(p.event_year)}, ${escStr(p.event_location)})`
}

function buildMergeSql(values: string[]): string {
  return `MERGE INTO ${SF_TABLE} AS t
    USING (SELECT * FROM VALUES ${values.join(',\n')}
      AS s(PHOTO_ID, EVENT_ID, SOURCE_FILENAME, DISPLAY_STAGE_PATH, THUMBNAIL_STAGE_PATH,
           DATE_TAKEN, CAMERA_MAKE, CAMERA_MODEL, LENS_MODEL, SOFTWARE, ARTIST,
           FOCAL_LENGTH, APERTURE, SHUTTER_SPEED, ISO, FLASH_USED,
           WHITE_BALANCE, EXPOSURE_MODE, SCENE_CAPTURE_TYPE,
           LATITUDE, LONGITUDE, ALTITUDE,
           COUNTRY, REGION, CITY, LOCATION_NAME,
           IPTC_KEYWORDS, IPTC_HEADLINE, CAPTION,
           AI_DESCRIPTION, AI_TAGS, FAVORITE, RATING, SEARCH_TEXT, UPDATED_AT,
           EVENT_NAME, EVENT_MONTH, EVENT_YEAR, EVENT_LOCATION)
    ) AS s ON t.PHOTO_ID = s.PHOTO_ID
    WHEN MATCHED THEN UPDATE SET
      t.EVENT_ID = s.EVENT_ID, t.SOURCE_FILENAME = s.SOURCE_FILENAME,
      t.DISPLAY_STAGE_PATH = s.DISPLAY_STAGE_PATH, t.THUMBNAIL_STAGE_PATH = s.THUMBNAIL_STAGE_PATH,
      t.DATE_TAKEN = s.DATE_TAKEN, t.CAMERA_MAKE = s.CAMERA_MAKE, t.CAMERA_MODEL = s.CAMERA_MODEL,
      t.LENS_MODEL = s.LENS_MODEL, t.SOFTWARE = s.SOFTWARE, t.ARTIST = s.ARTIST,
      t.FOCAL_LENGTH = s.FOCAL_LENGTH, t.APERTURE = s.APERTURE, t.SHUTTER_SPEED = s.SHUTTER_SPEED,
      t.ISO = s.ISO, t.FLASH_USED = s.FLASH_USED, t.WHITE_BALANCE = s.WHITE_BALANCE,
      t.EXPOSURE_MODE = s.EXPOSURE_MODE, t.SCENE_CAPTURE_TYPE = s.SCENE_CAPTURE_TYPE,
      t.LATITUDE = s.LATITUDE, t.LONGITUDE = s.LONGITUDE, t.ALTITUDE = s.ALTITUDE,
      t.COUNTRY = s.COUNTRY, t.REGION = s.REGION, t.CITY = s.CITY, t.LOCATION_NAME = s.LOCATION_NAME,
      t.IPTC_KEYWORDS = s.IPTC_KEYWORDS, t.IPTC_HEADLINE = s.IPTC_HEADLINE, t.CAPTION = s.CAPTION,
      t.AI_DESCRIPTION = s.AI_DESCRIPTION, t.AI_TAGS = s.AI_TAGS,
      t.FAVORITE = s.FAVORITE, t.RATING = s.RATING, t.SEARCH_TEXT = s.SEARCH_TEXT, t.UPDATED_AT = s.UPDATED_AT,
      t.EVENT_NAME = s.EVENT_NAME, t.EVENT_MONTH = s.EVENT_MONTH, t.EVENT_YEAR = s.EVENT_YEAR, t.EVENT_LOCATION = s.EVENT_LOCATION
    WHEN NOT MATCHED THEN INSERT
      (PHOTO_ID, EVENT_ID, SOURCE_FILENAME, DISPLAY_STAGE_PATH, THUMBNAIL_STAGE_PATH,
       DATE_TAKEN, CAMERA_MAKE, CAMERA_MODEL, LENS_MODEL, SOFTWARE, ARTIST,
       FOCAL_LENGTH, APERTURE, SHUTTER_SPEED, ISO, FLASH_USED,
       WHITE_BALANCE, EXPOSURE_MODE, SCENE_CAPTURE_TYPE,
       LATITUDE, LONGITUDE, ALTITUDE,
       COUNTRY, REGION, CITY, LOCATION_NAME,
       IPTC_KEYWORDS, IPTC_HEADLINE, CAPTION,
       AI_DESCRIPTION, AI_TAGS, FAVORITE, RATING, SEARCH_TEXT, UPDATED_AT,
       EVENT_NAME, EVENT_MONTH, EVENT_YEAR, EVENT_LOCATION)
      VALUES
      (s.PHOTO_ID, s.EVENT_ID, s.SOURCE_FILENAME, s.DISPLAY_STAGE_PATH, s.THUMBNAIL_STAGE_PATH,
       s.DATE_TAKEN, s.CAMERA_MAKE, s.CAMERA_MODEL, s.LENS_MODEL, s.SOFTWARE, s.ARTIST,
       s.FOCAL_LENGTH, s.APERTURE, s.SHUTTER_SPEED, s.ISO, s.FLASH_USED,
       s.WHITE_BALANCE, s.EXPOSURE_MODE, s.SCENE_CAPTURE_TYPE,
       s.LATITUDE, s.LONGITUDE, s.ALTITUDE,
       s.COUNTRY, s.REGION, s.CITY, s.LOCATION_NAME,
       s.IPTC_KEYWORDS, s.IPTC_HEADLINE, s.CAPTION,
       s.AI_DESCRIPTION, s.AI_TAGS, s.FAVORITE, s.RATING, s.SEARCH_TEXT, s.UPDATED_AT,
       s.EVENT_NAME, s.EVENT_MONTH, s.EVENT_YEAR, s.EVENT_LOCATION)`
}

function esc(v: unknown): string {
  if (v == null) return 'NULL'
  if (typeof v === 'number') return String(v)
  return 'NULL'
}

function escStr(v: unknown): string {
  if (v == null || v === '') return 'NULL'
  return `'${String(v).replace(/'/g, "''").replace(/\\/g, '\\\\')}'`
}

function escTs(v: unknown): string {
  if (v == null) return 'NULL'
  const d = v instanceof Date ? v : new Date(String(v))
  if (isNaN(d.getTime())) return 'NULL'
  return `'${d.toISOString().replace('T', ' ').replace('Z', '')}'::TIMESTAMP_NTZ`
}

function escBool(v: unknown): string {
  if (v == null) return 'NULL'
  return v ? 'TRUE' : 'FALSE'
}

const EVENT_SELECT_SQL = `SELECT e.owner_username, e.event_id, e.event_name, e.event_month, e.event_year, e.location, e.photo_count, e.updated_at
 FROM events e`

async function syncEvents(): Promise<{ synced: number }> {
  const queue = await pgQuery<Queued>(
    "SELECT id,revision FROM search_queue WHERE kind='event' ORDER BY queued_at LIMIT 200",
  )
  if (!queue.length) return { synced: 0 }
  const ids = queue.map((row) => row.id)
  const events = await pgQuery(EVENT_SELECT_SQL + ' WHERE e.event_id=ANY($1::int[])', [ids])

  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ]

  const eventValue = (e: Record<string, unknown>) => {
    const dateText =
      e.event_month && e.event_year
        ? `${monthNames[Number(e.event_month) - 1]} ${e.event_year}`
        : e.event_year
          ? String(e.event_year)
          : null
    const searchParts = [e.event_name, e.location, dateText].filter(Boolean)
    const searchText = searchParts.join(' | ')
    e.cost_units = Buffer.byteLength(searchText)
    return `(${esc(e.event_id)}, ${escStr(e.event_name)}, ${esc(e.event_month)}, ${esc(e.event_year)}, ${escStr(e.location)}, ${esc(e.photo_count)}, ${escStr(searchText)}, ${escTs(e.updated_at)})`
  }

  const eventSql = (values: string[]) => `MERGE INTO ${SF_EVENT_TABLE} AS t
    USING (SELECT * FROM VALUES ${values.join(',\n')}
      AS s(EVENT_ID, EVENT_NAME, EVENT_MONTH, EVENT_YEAR, LOCATION, PHOTO_COUNT, SEARCH_TEXT, UPDATED_AT)
    ) AS s ON t.EVENT_ID = s.EVENT_ID
    WHEN MATCHED THEN UPDATE SET
      t.EVENT_NAME = s.EVENT_NAME, t.EVENT_MONTH = s.EVENT_MONTH, t.EVENT_YEAR = s.EVENT_YEAR,
      t.LOCATION = s.LOCATION, t.PHOTO_COUNT = s.PHOTO_COUNT, t.SEARCH_TEXT = s.SEARCH_TEXT, t.UPDATED_AT = s.UPDATED_AT
    WHEN NOT MATCHED THEN INSERT
      (EVENT_ID, EVENT_NAME, EVENT_MONTH, EVENT_YEAR, LOCATION, PHOTO_COUNT, SEARCH_TEXT, UPDATED_AT)
      VALUES
      (s.EVENT_ID, s.EVENT_NAME, s.EVENT_MONTH, s.EVENT_YEAR, s.LOCATION, s.PHOTO_COUNT, s.SEARCH_TEXT, s.UPDATED_AT)`

  for (const batch of sqlByteBatches(events, eventValue, eventSql, searchSyncByteBudget()))
    await costWork(
      'search_indexing',
      ownerWeights(batch.records),
      () => querySnowflakeLongRunning(batch.sql, { maxWaitMs: 120_000, signal: databaseSignal() }),
      'EVENT_SEARCH_SERVICE',
    )
  const live = new Set(events.map((e) => Number(e.event_id)))
  const deleted = ids.filter((id) => !live.has(id))
  if (deleted.length)
    await querySnowflake(
      `DELETE FROM ${SF_EVENT_TABLE} WHERE EVENT_ID IN (${deleted.map(() => '?').join(',')})`,
      { binds: deleted },
    )
  await pgQuery(acknowledgeEventsSql, [ids, queue.map((row) => row.revision)])
  return { synced: events.length }
}

/** Explicit main-admin request only. Never resume the automatic indexing scheduler. */
async function syncSearchService(
  options: { force?: boolean; full?: boolean; signal?: AbortSignal } = {},
) {
  if (!options.force) return null
  return withAdvisoryLock('search-sync', async () => {
    await pgQuery(
      "INSERT INTO maintenance_state(name) VALUES ('search-sync') ON CONFLICT DO NOTHING",
    )
    try {
      if (options.full) await enqueueFullSearchRepair()
      // Reinforce manual mode before copying data. A crash or timeout cannot leave
      // an hourly scheduler running because this code never issues RESUME.
      for (const service of SEARCH_SERVICES)
        await querySnowflake(`ALTER CORTEX SEARCH SERVICE ${service} SUSPEND INDEXING`)
      const photos = { synced: 0 }
      const events = { synced: 0 }
      for (let batch = 0; batch < 5; batch++) {
        photos.synced += (await syncPhotos()).synced
        events.synced += (await syncEvents()).synced
        if (!(await pgQueryOne('SELECT 1 FROM search_queue LIMIT 1'))) break
      }
      // Always refresh on an explicit click, even with an empty outbox: a prior
      // index refresh may have failed after its table writes were acknowledged.
      for (const service of SEARCH_SERVICES) {
        const owners = await pgQuery<Record<string, unknown>>(
          `SELECT i.username AS owner_username,sum(i.units)::float8 AS count
          FROM cost_index_weights i JOIN cost_work w ON w.id=i.work_id WHERE i.service=$1 AND i.phase='merge'
          AND w.created_at>COALESCE((SELECT last_success FROM maintenance_state WHERE name='search-sync'),'1970-01-01'::timestamptz) GROUP BY i.username`,
          [service.split('.').at(-1)],
        )
        await costWork(
          'search_indexing',
          Object.fromEntries(owners.map((o) => [String(o.owner_username), Number(o.count)])),
          () =>
            querySnowflakeLongRunning(`ALTER CORTEX SEARCH SERVICE ${service} REFRESH`, {
              maxWaitMs: 120_000,
              signal: databaseSignal(),
            }),
          service.split('.').at(-1),
          'refresh',
        )
      }
      await pgQuery(
        "UPDATE maintenance_state SET last_success=NOW(),last_error=NULL WHERE name='search-sync'",
      )
      const remaining = await pgQueryOne<{ count: number }>(
        'SELECT count(*)::int AS count FROM search_queue',
      )
      return { photos, events, remaining: remaining?.count ?? 0 }
    } catch (error) {
      // Record an interrupted repair even when its caller's signal has expired.
      // A status-write outage must not hide the original repair failure.
      await withServiceDatabase(() =>
        pgQuery("UPDATE maintenance_state SET last_error=$1 WHERE name='search-sync'", [
          error instanceof Error ? error.message.slice(0, 500) : 'Sync failed',
        ]),
      ).catch(() => console.warn('[search-sync-status]'))
      throw error
    }
  })
}

export function syncSearch(...args: Parameters<typeof syncSearchService>) {
  return withServiceDatabase(() => syncSearchService(...args), args[0]?.signal)
}
