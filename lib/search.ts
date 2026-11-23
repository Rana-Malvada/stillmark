// Public search orchestration: resolve people and deterministic filters before retrieval.
import type { SearchOptions } from './search/search-options'
import { cleanScene } from './search/search-ranking'
import { asksForMetadata } from './search/search-metadata'
import { databaseSignal } from './database/database-context'
import { identifierRequirements } from './search/search-evidence'
import {
  calendarConstraint,
  calendarHasDay,
  geoConstraint,
  recurringCalendar,
} from './search/search-constraints'
import { interpretSearch } from './search/search-intent'
import { HttpError } from './http'
import {
  peopleById,
  type PersonMatch,
  type PersonSuggestion,
  redactNames,
  resolvePeople,
  suggestPeople,
  withAnyPerson,
} from './people/people-search'
import { addPlaceAndPeriod, catalogPlace } from './search/query'
import { retrieveEligible } from './search/retrieval'
import { searchInterpreted } from './search/interpretation'
import { searchText } from './search/text'

export { searchOptions, type SearchOptions } from './search/search-options'
export { semanticMatches } from './search/search-semantic'
export { cleanScene, fuseRanks, fuseSearchRanks } from './search/search-ranking'
export { searchInterpreted } from './search/interpretation'
export { hydrateSearchIds } from './search/retrieval'

export async function search(
  kind: 'photo' | 'event',
  options: SearchOptions,
  allowedIds: number[],
) {
  databaseSignal()?.throwIfAborted()
  if (options.eventId && !allowedIds.includes(options.eventId))
    throw new HttpError(404, 'Album not found')
  const explicit = options.people ?? []
  if ((!options.query && !explicit.length) || !allowedIds.length)
    return { query: '', results: [], count: 0, source: 'postgres', people: [], suggestions: [] }
  const selected = await peopleById(explicit)
  const unresolvedQuery = redactNames(options.query, selected).replaceAll('[person]', '')
  let parsed = options.query
    ? await resolvePeople(unresolvedQuery)
    : { people: [] as PersonMatch[], remainder: '' }
  let excluded: PersonMatch[] = []
  const exclusion = /^(.*?)(?:\bwithout\b|\bexcluding\b|\bexcept\b|\bbut not\b)(.+)$/i.exec(
    unresolvedQuery,
  )
  if (exclusion && !/\b(or|neither|without|except|excluding|not)\b/i.test(exclusion[2])) {
    const left = await resolvePeople(exclusion[1])
    const right = await resolvePeople(exclusion[2])
    const rightCalendar = calendarConstraint(right.remainder)
    if (
      right.people.length &&
      !cleanScene(rightCalendar?.scene ?? right.remainder) &&
      (left.people.length || !cleanScene(left.remainder)) &&
      !/\b(or|neither|without|except|excluding|not)\b/i.test(left.remainder)
    ) {
      excluded = right.people
      parsed = { ...left, remainder: `${left.remainder} ${right.remainder}`.trim() }
    }
  }
  const people = [...selected]
  for (const p of parsed.people) if (!people.some((q) => q.personId === p.personId)) people.push(p)
  const suggestions: PersonSuggestion[] = options.query
    ? await suggestPeople(unresolvedQuery, allowedIds)
    : []
  const interpret = async () => {
    const interpreted = await interpretSearch(
      options.query,
      selected.map((p) => p.name),
      kind,
    )
    const result = await searchInterpreted(kind, options, allowedIds, selected, interpreted.intent)
    return { ...result, suggestions, interpretation: interpreted.metrics }
  }
  const geo = geoConstraint(parsed.remainder)
  const calendar = calendarConstraint(geo?.scene ?? parsed.remainder)
  const unresolvedLogic = calendar?.scene ?? geo?.scene ?? parsed.remainder
  // Only unresolved logic needs a model. Sentence length and an empty result are
  // not interpretation signals: ordinary descriptions belong to semantic retrieval.
  if (
    asksForMetadata(unresolvedLogic) ||
    (!excluded.length &&
      /\b(without|except|excluding|exclude|neither|not|omit|omitting|leaving out)\b|\bno\b(?![.]?\s*\d)/i.test(
        unresolvedLogic,
      )) ||
    /\b(before|after|between|since|until)\b/i.test(unresolvedLogic) ||
    /\bfrom\s+\d{4}\s+(?:to|through|until)\b/i.test(unresolvedLogic) ||
    /\bor\b/i.test(unresolvedLogic)
  ) {
    if (options.interpretationAllowed === false)
      return {
        query: options.query,
        results: [],
        count: 0,
        source: 'people',
        people,
        suggestions,
        clarification: 'This query needs interactive interpretation.',
      }
    try {
      return await interpret()
    } catch (error) {
      databaseSignal()?.throwIfAborted()
      // Only a request the interpreter rejected is answered with a clarification, which
      // the caller may cache. Allowance, provider and unexpected failures must surface
      // as errors so a temporary outage is never saved as this query's answer.
      if (!(error instanceof HttpError) || error.status === 429 || error.status >= 500) throw error
      return {
        query: options.query,
        results: [],
        count: 0,
        source: 'people',
        people,
        suggestions,
        clarification:
          'The relationship or exclusion in this search could not be interpreted. Try simplifying it; no filters were silently removed.',
      }
    }
  }
  const recurring = recurringCalendar(unresolvedLogic)
  const place = await catalogPlace(
    recurring?.scene ?? unresolvedLogic,
    options.eventId ? [options.eventId] : allowedIds,
  )
  if ((recurring || place) && /\bor\b/i.test(unresolvedLogic)) {
    return {
      query: options.query,
      results: [],
      count: 0,
      source: 'people',
      people,
      suggestions,
      clarification: 'Please search one place or time period at a time for this combination.',
    }
  }
  if (calendar || geo || excluded.length || recurring || place) {
    const params: unknown[] = [allowedIds]
    const bind = (value: unknown, type: string) => `$${params.push(value)}::${type}`
    const clauses = ["p.ingest_status='READY'", 'p.event_id=ANY($1::int[])']
    if (calendar) {
      const precise = calendarHasDay(parsed.remainder)
      const date = precise
        ? 'p.date_taken::date'
        : 'COALESCE(p.date_taken::date, make_date(e.event_year,COALESCE(NULLIF(e.event_month,0),1),1))'
      if (calendar.from) clauses.push(`${date}>=${bind(calendar.from, 'date')}`)
      if (calendar.through) clauses.push(`${date}<=${bind(calendar.through, 'date')}`)
    }
    addPlaceAndPeriod(clauses, bind, recurring, place)
    if (geo) {
      const lat = bind(geo.latitude, 'float8')
      const lng = bind(geo.longitude, 'float8')
      const radius = bind(geo.km, 'float8')
      clauses.push(
        `p.latitude IS NOT NULL AND p.longitude IS NOT NULL
         AND 6371.0088*acos(least(1.0,greatest(-1.0,
           sin(radians(p.latitude))*sin(radians(${lat}))
           +cos(radians(p.latitude))*cos(radians(${lat}))*cos(radians(p.longitude-${lng}))
         )))<=${radius}`,
      )
    }
    for (const p of people) clauses.push(withAnyPerson(bind(p.personIds ?? [p.personId], 'uuid[]')))
    for (const p of excluded)
      clauses.push(`NOT ${withAnyPerson(bind(p.personIds ?? [p.personId], 'uuid[]'))}`)
    if (options.eventId) clauses.push(`p.event_id=${bind(options.eventId, 'int')}`)
    const scene = cleanScene(place?.scene ?? recurring?.scene ?? unresolvedLogic)
    const results = await retrieveEligible(
      kind,
      options,
      allowedIds,
      clauses.join(' AND '),
      params,
      scene,
    )
    return {
      query: options.query,
      results,
      count: results.length,
      source: scene ? 'semantic' : 'people',
      people,
      suggestions,
      filters: {
        place: place?.place,
        months: recurring?.months,
        excludedPeople: excluded,
        from: calendar?.from,
        through: calendar?.through,
        near: geo ? { latitude: geo.latitude, longitude: geo.longitude, km: geo.km } : undefined,
      },
    }
  }

  const result = people.length
    ? await searchPeople(kind, options, allowedIds, people, cleanScene(parsed.remainder))
    : await searchText(kind, options, allowedIds)

  return {
    ...result,
    people,
    suggestions,
    ...(result.results.length === 0 && identifierRequirements(options.query).length
      ? {
          notice:
            'No photos have supporting text, tags, or OCR for the requested number or plate. Photos with missing evidence are not included.',
        }
      : {}),
  }
}

async function searchPeople(
  kind: 'photo' | 'event',
  options: SearchOptions,
  allowedIds: number[],
  people: PersonMatch[],
  remainder: string,
) {
  const params: unknown[] = [allowedIds]
  const clauses = ["p.ingest_status='READY'", 'p.event_id=ANY($1::int[])']
  for (const p of people)
    clauses.push(withAnyPerson(`$${params.push(p.personIds ?? [p.personId])}::uuid[]`))
  if (options.eventId) clauses.push(`p.event_id=$${params.push(options.eventId)}::int`)
  const results = await retrieveEligible(
    kind,
    options,
    allowedIds,
    clauses.join(' AND '),
    params,
    remainder,
  )
  return {
    query: options.query,
    results,
    count: results.length,
    source: remainder ? 'semantic' : 'people',
    rankingQuery: remainder,
  }
}
