import { pgQuery } from '@/lib/postgres'
import { HttpError } from '@/lib/http'
import { personNames, replacePersonName } from '../person-name'

/** Settled matches only: suggestions awaiting review never affect search. */
const SETTLED = `a.status IN ('auto','confirmed')`
const MAX_PEOPLE = 5
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface PersonMatch {
  personId: string
  name: string
  /** Separate visible records that share this full name; alternatives, not a merge. */
  personIds?: string[]
}
export interface ParsedPeopleQuery {
  people: PersonMatch[]
  /** The query with matched names removed; searched as keywords. */
  remainder: string
  ambiguous?: string[]
}
export interface PersonSuggestion extends PersonMatch {
  coverFaceId: number | null
  photoCount: number
  query?: string
}

export function personIds(values: string[]): string[] {
  const ids = [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))]
  if (ids.length > MAX_PEOPLE) throw new HttpError(400, 'Too many people')
  if (ids.some((id) => !UUID.test(id))) throw new HttpError(400, 'Invalid person')
  return ids
}

const words = (text: string) => text.split(/\s+/).filter(Boolean)
const normalize = (text: string) =>
  words(text)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .join(' ')
    .toLowerCase()

/** Candidate name phrases, bounded by the already-limited query length. */
export function namePhrases(query: string): string[] {
  const tokens = words(query.toLowerCase())
  const phrases = new Set<string>()
  for (let size = 1; size <= tokens.length; size++)
    for (let start = 0; start + size <= tokens.length; start++)
      phrases.add(normalize(tokens.slice(start, start + size).join(' ')))
  return [...phrases]
}

/**
 * Longest-first, non-overlapping match of query phrases against visible names.
 * Identical full names are alternatives across visible library records.
 * A first name includes every visible person matching that first name.
 */
export function parsePeople(query: string, visible: PersonMatch[]): ParsedPeopleQuery {
  const byName = new Map<string, PersonMatch[]>()
  for (const person of visible) {
    for (const key of personNames(person.name))
      byName.set(normalize(key), [...(byName.get(normalize(key)) ?? []), person])
  }
  const tokens = words(query)
  const used = Array.from({ length: tokens.length }, () => false)
  const people: PersonMatch[] = []
  for (
    let size = Math.min(
      tokens.length,
      Math.max(1, ...[...byName.keys()].map((key) => words(key).length)),
    );
    size >= 1;
    size--
  )
    for (let start = 0; start + size <= tokens.length; start++) {
      if (used.slice(start, start + size).some(Boolean)) continue
      const found = byName.get(normalize(tokens.slice(start, start + size).join(' ')))
      if (found && found.length > 1) {
        const sameName = found.every(
          (person) => normalize(person.name) === normalize(found[0].name),
        )
        const name = sameName ? found[0].name : tokens.slice(start, start + size).join(' ')
        if (!people.some((person) => normalize(person.name) === normalize(name)))
          people.push({
            ...found[0],
            name,
            personIds: [...new Set(found.map((person) => person.personId))],
          })
        used.fill(true, start, start + size)
        continue
      }
      if (found?.length !== 1 || people.some((p) => p.personId === found[0].personId)) continue
      people.push(found[0])
      used.fill(true, start, start + size)
    }
  if (people.length > MAX_PEOPLE)
    throw new HttpError(400, 'Search supports at most five named people groups at a time')
  return {
    people,
    remainder: tokens.filter((_, i) => !used[i]).join(' '),
  }
}

/** Resolves names the caller may see. Row security limits candidates to visible people. */
export async function resolvePeople(query: string): Promise<ParsedPeopleQuery> {
  const phrases = namePhrases(query)
  if (!phrases.length) return { people: [], remainder: query }
  const visible = await pgQuery<PersonMatch>(
    `SELECT person_id AS "personId", name FROM face_people
     WHERE name IS NOT NULL AND NOT hidden
       AND (lower(name)=ANY($1::text[]) OR lower(split_part(trim(name),' ',1))=ANY($1::text[]))`,
    [phrases],
  )
  return parsePeople(query, visible)
}

export async function peopleById(ids: string[]): Promise<PersonMatch[]> {
  if (!ids.length) return []
  const rows = await pgQuery<PersonMatch>(
    `SELECT person_id AS "personId", name FROM face_people
     WHERE person_id=ANY($1::uuid[]) AND name IS NOT NULL AND NOT hidden`,
    [ids],
  )
  if (rows.length !== ids.length) throw new HttpError(404, 'Person not found')
  const grouped: PersonMatch[] = []
  for (const id of ids) {
    const row = rows.find((r) => r.personId === id)!
    if (grouped.some((p) => normalize(p.name) === normalize(row.name))) continue
    // Re-resolve only visible alternatives; choosing a suggestion must not narrow to one library.
    const matches = await resolvePeople(row.name)
    grouped.push(matches.people.find((p) => normalize(p.name) === normalize(row.name)) ?? row)
  }
  return grouped
}

/** A photo must contain a settled match to at least one alternative identity. */
export function withAnyPerson(param: string) {
  return `EXISTS (
    SELECT 1 FROM faces f JOIN face_assignments a USING(face_id)
    WHERE f.photo_id=p.photo_id AND a.person_id=ANY(${param}::uuid[])
      AND ${SETTLED} AND NOT f.ignored)`
}

/** People-row suggestions: prefix or fuzzy name matches with photo counts in reach. */
export async function suggestPeople(query: string, allowedIds: number[]) {
  const text = normalize(query)
  if (text.length < 2 || !allowedIds.length) return []
  const rows = await pgQuery<PersonSuggestion>(
    `WITH grouped AS (
     SELECT (array_agg(p.person_id ORDER BY p.person_id))[1] AS "personId",
       (array_agg(p.name ORDER BY p.person_id))[1] AS name,
       array_agg(DISTINCT p.person_id) AS "personIds",
       (array_agg(p.cover_face_id ORDER BY p.person_id) FILTER (WHERE p.cover_face_id IS NOT NULL))[1] AS "coverFaceId",
       count(DISTINCT f.photo_id)::int AS "photoCount"
     FROM face_people p JOIN face_assignments a ON a.person_id=p.person_id AND ${SETTLED}
     JOIN faces f ON f.face_id=a.face_id AND NOT f.ignored
     JOIN photos ph ON ph.photo_id=f.photo_id AND ph.event_id=ANY($2::int[]) AND ph.ingest_status='READY'
     WHERE p.name IS NOT NULL AND NOT p.hidden
       AND (lower(p.name) LIKE $3 || '%' OR lower(p.name) LIKE '% ' || $3 || '%' OR similarity(lower(p.name), $1) >= 0.35
         OR lower(split_part(trim(p.name),' ',1))=ANY($4::text[]))
     GROUP BY lower(regexp_replace(trim(p.name),'\\s+',' ','g')))
     SELECT * FROM grouped
     ORDER BY (lower(name)=$1) DESC, (lower(name) LIKE $3 || '%') DESC, similarity(lower(name), $1) DESC, name
     LIMIT 8`,
    [text, allowedIds, text.replace(/[\\%_]/g, (c) => '\\' + c), namePhrases(query)],
  )
  return rows.map((person) => {
    const remainder = replacePersonName(query, person.name, '')
    return { ...person, query: remainder === query.trim() ? '' : remainder }
  })
}

/**
 * The query text safe to store in the activity log: named and excluded people are
 * replaced. A result whose people were withheld because the library changed cannot
 * be redacted by name, so its query is not stored at all.
 */
export function loggedSearchQuery(query: string, result: Record<string, unknown>): string {
  if (result.notice) return '[query withheld]'
  const filters = result.filters as { excludedPeople?: PersonMatch[] } | undefined
  return redactNames(query, [
    ...((result.people ?? []) as PersonMatch[]),
    ...(filters?.excludedPeople ?? []),
  ])
}
/** Replaces matched names with a placeholder so activity logs never store them. */
export function redactNames(query: string, people: PersonMatch[]): string {
  let out = query
  for (const { name } of [...people].sort((a, b) => b.name.length - a.name.length))
    out = replacePersonName(out, name, '[person]')
  return out
}
