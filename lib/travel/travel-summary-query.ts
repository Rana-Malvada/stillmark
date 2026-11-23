import { ALBUM_READ_SQL } from '../albums/album-sql'

// Fresh summaries and dirty-album raw rows are mutually exclusive within one SQL
// snapshot. Event ownership, visibility, names and fallback years are always live.
const READY = `ready AS (SELECT event_id FROM travel_summary_state WHERE built_revision=revision)`
const SCOPE = `${ALBUM_READ_SQL} AND ($3::boolean OR e.owner_username=$1)`
export const travelSummaryOverviewSql = `WITH ${READY}, source AS (
 SELECT a.event_id,e.event_name,COALESCE(a.capture_year,e.event_year) AS year,a.lat,a.lng,a.country,a.city,a.count,a.photo_id,a.thumbnail_photo_id
 FROM travel_area_summary a JOIN ready r USING(event_id) JOIN events e USING(event_id) WHERE ${SCOPE}
 UNION ALL
 SELECT p.event_id,e.event_name,COALESCE(EXTRACT(YEAR FROM p.date_taken AT TIME ZONE 'UTC')::int,e.event_year),
 CASE WHEN p.latitude BETWEEN -90 AND 90 AND p.longitude BETWEEN -180 AND 180 THEN round(p.latitude::numeric,1)::float8 END,
 CASE WHEN p.latitude BETWEEN -90 AND 90 AND p.longitude BETWEEN -180 AND 180 THEN round(p.longitude::numeric,1)::float8 END,
 COALESCE(NULLIF(trim(p.country),''),''),COALESCE(NULLIF(trim(p.city),''),''),1::bigint,p.photo_id,CASE WHEN p.thumbnail_stage_path IS NOT NULL THEN p.photo_id END
 FROM photos p JOIN events e ON e.event_id=p.event_id WHERE ${SCOPE} AND NOT EXISTS(SELECT FROM ready r WHERE r.event_id=p.event_id)
), grouped AS (
 SELECT event_id,event_name,year,lat,lng,country,city,sum(count)::int AS count,COALESCE(min(thumbnail_photo_id),min(photo_id)) AS photo_id
 FROM source GROUP BY event_id,event_name,year,lat,lng,country,city
) SELECT g.*,p.thumbnail_stage_path AS thumbnail FROM grouped g JOIN photos p ON p.photo_id=g.photo_id
 ORDER BY year DESC NULLS LAST,g.event_id,lat,lng`

export const travelSummaryViewportSql = `WITH ${READY}, source AS (
 SELECT a.event_id,a.lat,a.lng,a.count,a.photo_id,COALESCE(a.capture_year,e.event_year) AS year
 FROM travel_point_summary a JOIN ready r USING(event_id) JOIN events e USING(event_id) WHERE ${SCOPE}
 UNION ALL
 SELECT p.event_id,p.latitude,p.longitude,1::bigint,p.photo_id,COALESCE(EXTRACT(YEAR FROM p.date_taken AT TIME ZONE 'UTC')::int,e.event_year)
 FROM photos p JOIN events e ON e.event_id=p.event_id WHERE ${SCOPE} AND NOT EXISTS(SELECT FROM ready r WHERE r.event_id=p.event_id)
), cells AS (
 SELECT floor(lng/$8)::int AS x,floor(lat/$8)::int AS y,
 (sum(lat*count)/sum(count))::float8 AS lat,(sum(lng*count)/sum(count))::float8 AS lng,sum(count)::int AS count,
 count(DISTINCT (lat,lng))::int AS points,min(photo_id) AS representative
 FROM source WHERE lat BETWEEN $4 AND $5 AND lng BETWEEN $6 AND $7
 AND ($9='all' OR ($9='undated' AND year IS NULL) OR year::text=$9)
 GROUP BY x,y
) SELECT c.*,round(p.latitude::numeric,1)::float8 AS area_lat,round(p.longitude::numeric,1)::float8 AS area_lng
 FROM cells c JOIN photos p ON p.photo_id=c.representative ORDER BY x,y`
