// Bound SQL projections and catalog constraints shared by both search paths.
import type { SearchOptions } from './search-options'
import { placePhrase, recurringCalendar } from './search-constraints'
import { getImageProxyUrl } from '../media/image-proxy-url'
import { pgQuery } from '../postgres'

export const PHOTO_SELECT = `SELECT p.photo_id AS "photoId", p.event_id AS "eventId", p.source_filename AS "sourceFilename",
 p.display_stage_path AS "displayStagePath", p.thumbnail_stage_path AS "thumbnailStagePath", p.date_taken AS "dateTaken",
 p.camera_make AS "cameraMake", p.camera_model AS "cameraModel", p.lens_model AS "lensModel", p.country, p.region, p.city,
 p.location_name AS "locationName", p.ai_description AS "aiDescription", p.ai_tags AS "aiTags", p.iptc_keywords AS "iptcKeywords",
 (SELECT ocr_text FROM search_enrichment se WHERE se.photo_id=p.photo_id AND se.status='completed' AND se.source_path=p.original_stage_path) AS "ocrText",
 p.caption, p.user_tags AS "userTags", p.favorite, e.event_name AS "eventName" FROM photos p JOIN events e ON e.event_id=p.event_id`
export const PHOTO_SUBJECT = `to_tsvector('english',concat_ws(' ',p.ai_description,p.caption,p.ai_tags::text,p.user_tags::text,p.iptc_keywords::text,
 (SELECT se.ocr_text FROM search_enrichment se WHERE se.photo_id=p.photo_id AND se.status='completed' AND se.source_path=p.original_stage_path)))`
export const subjectSelect = (param: string) =>
  PHOTO_SELECT.replace(
    'SELECT ',
    `SELECT (${PHOTO_SUBJECT} @@ websearch_to_tsquery('english',${param})) AS "subjectMatch", `,
  )
export const EVENT_SELECT = `SELECT e.event_id AS "eventId", e.event_name AS "eventName", e.event_month AS "eventMonth",
 e.event_year AS "eventYear", e.location, e.photo_count AS "photoCount", p.thumbnail_stage_path AS "coverPath"
 FROM events e LEFT JOIN photos p ON p.photo_id=e.cover_photo_id`

// Photo metadata takes precedence over album context. Album titles are a fallback
// only for photos without a recorded place and albums without a location field.
export function placePredicate(param: string) {
  return `(lower(${param}) IN (lower(p.city),lower(p.region),lower(p.country),lower(p.location_name))
    OR (NULLIF(trim(concat_ws('',p.city,p.region,p.location_name,p.country)),'') IS NULL
      AND ((lower(e.location)=lower(${param}) OR lower(${param})=ANY(regexp_split_to_array(lower(trim(e.location)),' *, *'))) OR (NULLIF(trim(e.location),'') IS NULL
        AND to_tsvector('simple',e.event_name) @@ phraseto_tsquery('simple',${param})))))`
}
export async function catalogPlace(query: string, albums: number[]) {
  const phrase = placePhrase(query)
  if (!phrase) return null
  const [found] = await pgQuery<{ place: string }>(
    `SELECT place FROM unnest($2::text[]) WITH ORDINALITY AS terms(place,ord)
     WHERE EXISTS (SELECT FROM photos p JOIN events e ON e.event_id=p.event_id
      WHERE p.event_id=ANY($1::int[]) AND p.ingest_status='READY' AND ${placePredicate('terms.place')})
     ORDER BY ord LIMIT 1`,
    [albums, phrase.candidates],
  )
  const place = found?.place
  if (!place) {
    // An explicitly named destination with no catalog evidence must still be a filter.
    if (!/^\p{Lu}[\p{L}’'.-]*(?:\s+\p{Lu}[\p{L}’'.-]*)*$/u.test(phrase.phrase)) return null
    return { place: phrase.phrase, scene: [phrase.before, phrase.after].join(' ').trim() }
  }
  return {
    place,
    scene: [phrase.before, phrase.phrase.slice(place.length), phrase.after].join(' ').trim(),
  }
}

export function addPlaceAndPeriod(
  clauses: string[],
  bind: (value: unknown, type: string) => string,
  recurring: ReturnType<typeof recurringCalendar>,
  place: Awaited<ReturnType<typeof catalogPlace>>,
) {
  if (recurring) {
    const month = 'COALESCE(EXTRACT(MONTH FROM p.date_taken)::int,NULLIF(e.event_month,0))'
    const localMonth = recurring.seasonal
      ? `CASE WHEN p.latitude<0 THEN ((${month}+5)%12)+1 ELSE ${month} END`
      : month
    clauses.push(`${localMonth}=ANY(${bind(recurring.months, 'int[]')})`)
    if (recurring.year)
      clauses.push(
        `COALESCE(EXTRACT(YEAR FROM p.date_taken)::int,e.event_year)=${bind(recurring.year, 'int')}`,
      )
  }
  if (place) clauses.push(placePredicate(bind(place.place, 'text')))
}

export async function mountainDestinationPredicate(
  options: SearchOptions,
  allowedIds: number[],
  bind: (value: unknown, type: string) => string,
) {
  const { mountainRangeNames } = await import('./search-mountain-ranges')
  const albumCity = "lower(trim(split_part(e.location,',',1)))"
  const albumCountry =
    "lower(trim((string_to_array(e.location,','))[array_length(string_to_array(e.location,','),1)]))"
  const city = `coalesce(nullif(lower(trim(p.city)),''),nullif(lower(trim(p.location_name)),''),${albumCity})`
  const country = `coalesce(nullif(lower(trim(p.country)),''),${albumCountry})`
  const locations = await pgQuery<{ city: string; country: string }>(
    `SELECT DISTINCT ${city} AS city,${country} AS country FROM photos p JOIN events e USING(event_id) WHERE p.event_id=ANY($1::int[]) AND p.ingest_status='READY'`,
    [options.eventId ? [options.eventId] : allowedIds],
  )
  const mountainLocations = locations
    .filter((row) => row.country && row.city && mountainRangeNames(row.country).includes(row.city))
    .map((row) => row.country + '|' + row.city)
  if (mountainLocations.length)
    return `coalesce((${country}||'|'||${city})=ANY(${bind(mountainLocations, 'text[]')}),false)`
  return 'FALSE'
}

export function withCoverUrls(results: Record<string, unknown>[]): Record<string, unknown>[] {
  return results.map(({ coverPath, ...event }) => ({
    ...event,
    coverUrl: coverPath ? getImageProxyUrl(String(coverPath)) : null,
  }))
}
