// Resolve interpreted names under live RLS before compiling their bound predicates.
import type { SearchOptions } from './search-options'
import type { SearchIntent } from './search-intent'
import { databaseSignal } from '../database/database-context'
import { albumDomainExpression, compileExpression, containsPhotoScope } from './search-expression'
import { asksForMetadata, metadataClause } from './search-metadata'
import { calendarConstraint, calendarHasDay, recurringCalendar } from './search-constraints'
import { cleanScene } from './search-ranking'
import { type PersonMatch, resolvePeople, withAnyPerson } from '../people/people-search'
import { HttpError } from '../http'
import {
  addPlaceAndPeriod,
  catalogPlace,
  mountainDestinationPredicate,
  PHOTO_SUBJECT,
  placePredicate,
} from './query'
import { retrieveAlbums, retrieveEligible } from './retrieval'

/** Resolve every model-supplied name under current RLS before building bound SQL. */
export async function searchInterpreted(
  kind: 'photo' | 'event',
  options: SearchOptions,
  allowedIds: number[],
  selected: PersonMatch[],
  intent: SearchIntent,
) {
  databaseSignal()?.throwIfAborted()
  // Replayed searches enter here directly, so the album filter is authorized here too.
  if (options.eventId && !allowedIds.includes(options.eventId))
    throw new HttpError(404, 'Album not found')
  const people = [...selected]
  const empty = (clarification: string) => ({
    query: options.query,
    results: [],
    count: 0,
    source: 'people',
    people,
    clarification,
  })
  if (intent.clarification) return empty(intent.clarification)
  if (
    !intent.where &&
    asksForMetadata(options.query) &&
    !intent.metadata?.length &&
    !intent.keywords &&
    !intent.place &&
    !intent.excludedKeywords.length &&
    !intent.excludedPlaces?.length &&
    !intent.fromYear &&
    !intent.throughYear
  )
    return empty('I could not identify which photo or album field to filter on.')
  if (intent.where) {
    if (
      containsPhotoScope(intent.where) &&
      (!albumDomainExpression(intent.where) || intent.keywords)
    )
      return empty('Please put photo conditions together within the album search.')
    const params: unknown[] = [allowedIds]
    const bind = (value: unknown, type: string) => `$${params.push(value)}::${type}`
    let mountainClause: Promise<string> | undefined
    const selectedClause = () =>
      selected
        .map((person) => withAnyPerson(bind(person.personIds ?? [person.personId], 'uuid[]')))
        .join(' AND ')
    const resolveAtom: Parameters<typeof compileExpression>[2] = async (atom) => {
      if ('photo' in atom) {
        if (kind !== 'event' || containsPhotoScope(atom.photo))
          throw new HttpError(422, 'Photo grouping is only available once within album searches.')
        const condition = await compileExpression(atom.photo, bind, resolveAtom)
        const selectedFilter = selectedClause()
        return `EXISTS(SELECT FROM photos p WHERE p.event_id=e.event_id AND p.ingest_status='READY' AND (${condition})${selectedFilter ? ' AND ' + selectedFilter : ''})`
      }
      if ('person' in atom) {
        const resolved = await resolvePeople(atom.person)
        if (resolved.people.length !== 1 || resolved.remainder.trim())
          throw new HttpError(422, `Choose a People entry for "${atom.person}".`)
        const person = resolved.people[0]
        if (!people.some((p) => p.personId === person.personId)) people.push(person)
        return withAnyPerson(bind(person.personIds ?? [person.personId], 'uuid[]'))
      }
      if ('place' in atom) return `COALESCE(${placePredicate(bind(atom.place, 'text'))},false)`
      if ('terrain' in atom)
        return (mountainClause ??= mountainDestinationPredicate(options, allowedIds, bind))
      if ('near' in atom) {
        const { latitude, longitude, km } = atom.near
        return `p.latitude IS NOT NULL AND p.longitude IS NOT NULL
          AND 6371.0088*acos(least(1.0,greatest(-1.0,
            sin(radians(p.latitude))*sin(radians(${bind(latitude, 'float8')}))
            +cos(radians(p.latitude))*cos(radians(${bind(latitude, 'float8')}))*cos(radians(p.longitude-${bind(longitude, 'float8')}))
          )))<=${bind(km, 'float8')}`
      }
      const recurring = recurringCalendar(atom.period)
      const calendar = calendarConstraint(atom.period)
      const clauses: string[] = []
      if (recurring) addPlaceAndPeriod(clauses, bind, recurring, null)
      else if (calendar) {
        const date = calendarHasDay(atom.period)
          ? 'p.date_taken::date'
          : 'COALESCE(p.date_taken::date,make_date(e.event_year,COALESCE(NULLIF(e.event_month,0),1),1))'
        if (calendar.from) clauses.push(`${date}>=${bind(calendar.from, 'date')}`)
        if (calendar.through) clauses.push(`${date}<=${bind(calendar.through, 'date')}`)
      } else throw new HttpError(422, 'The requested date or season could not be interpreted.')
      if (cleanScene(recurring?.scene ?? calendar?.scene ?? ''))
        throw new HttpError(422, 'The requested date contains an unrecognized condition.')
      return '(' + clauses.join(' AND ') + ')'
    }
    const clause = await compileExpression(intent.where, bind, resolveAtom)
    const clauses = ['e.event_id=ANY($1::int[])', clause]
    if (options.eventId) clauses.push(`e.event_id=${bind(options.eventId, 'int')}`)
    const albumOnly = kind === 'event' && !intent.keywords && albumDomainExpression(intent.where)
    if (selected.length) {
      const selectedFilter = selectedClause()
      clauses.push(
        albumOnly
          ? `EXISTS(SELECT FROM photos p WHERE p.event_id=e.event_id AND p.ingest_status='READY' AND ${selectedFilter})`
          : selectedFilter,
      )
    }
    if (!albumOnly) clauses.push("p.ingest_status='READY'")
    const results = albumOnly
      ? await retrieveAlbums(options, clauses.join(' AND '), params)
      : await retrieveEligible(
          kind,
          options,
          allowedIds,
          clauses.join(' AND '),
          params,
          intent.keywords,
        )
    return {
      query: options.query,
      results,
      count: results.length,
      source: intent.keywords ? 'semantic' : 'people',
      people,
      rankingQuery: intent.keywords,
      replayPlan: intent,
    }
  }
  const resolved = new Map<string, PersonMatch>()
  for (const name of new Set(intent.branches.flatMap((b) => [...b.include, ...b.exclude]))) {
    const match = await resolvePeople(name)
    if (match.ambiguous?.length || match.people.length !== 1 || match.remainder.trim())
      return empty(
        `Choose a People entry for "${name}"; this name could not be resolved uniquely in the libraries you can access.`,
      )
    resolved.set(name, match.people[0])
    if (!people.some((p) => p.personId === match.people[0].personId)) people.push(match.people[0])
  }
  const params: unknown[] = [allowedIds]
  const bind = (v: unknown, type: string) => `$${params.push(v)}::${type}`
  const personClause = (person: PersonMatch) =>
    withAnyPerson(bind(person.personIds ?? [person.personId], 'uuid[]'))
  const branches = intent.branches.map(
    (b) =>
      [
        ...b.include.map((n) => personClause(resolved.get(n)!)),
        ...b.exclude.map((n) => `NOT ${personClause(resolved.get(n)!)}`),
      ].join(' AND ') || 'TRUE',
  )
  const clauses = [
    `p.event_id=ANY($1::int[])`,
    "p.ingest_status='READY'",
    `(${branches.map((b) => `(${b})`).join(' OR ')})`,
    ...selected.map(personClause),
  ]
  if (options.eventId) clauses.push(`p.event_id=${bind(options.eventId, 'int')}`)
  // Fall back to album year only when the photograph has no date.
  const year =
    'COALESCE(EXTRACT(YEAR FROM p.date_taken)::int,(SELECT event_year FROM events WHERE event_id=p.event_id))'
  if (intent.fromYear !== null) clauses.push(`${year}>=${bind(intent.fromYear, 'int')}`)
  if (intent.throughYear !== null) clauses.push(`${year}<=${bind(intent.throughYear, 'int')}`)
  for (const filter of intent.metadata ?? []) clauses.push(metadataClause(filter, bind))
  for (const excluded of intent.excludedKeywords)
    clauses.push(`NOT (${PHOTO_SUBJECT} @@ plainto_tsquery('english',${bind(excluded, 'text')}))`)
  if (intent.alternativePlaces?.length) {
    if (intent.place)
      return empty('Please specify whether the named destinations are alternatives.')
    clauses.push(
      '(' +
        intent.alternativePlaces
          .map((destination) => placePredicate(bind(destination, 'text')))
          .join(' OR ') +
        ')',
    )
  }
  if (intent.excludeMountainDestinations) {
    clauses.push(`NOT (${await mountainDestinationPredicate(options, allowedIds, bind)})`)
  }
  for (const destination of intent.excludedPlaces ?? [])
    clauses.push(`NOT COALESCE(${placePredicate(bind(destination, 'text'))},false)`)
  const recurring = recurringCalendar(intent.keywords)
  const remainder = recurring?.scene ?? intent.keywords
  const place = intent.place
    ? { place: intent.place, scene: remainder }
    : await catalogPlace(remainder, options.eventId ? [options.eventId] : allowedIds)
  addPlaceAndPeriod(clauses, bind, recurring, place)
  if ((recurring || place) && /\bor\b/i.test(intent.keywords))
    return empty('Please search one place or time period at a time for this combination.')
  const scene = cleanScene(place?.scene ?? recurring?.scene ?? intent.keywords)
  const base = clauses.join(' AND ')
  const results = await retrieveEligible(kind, options, allowedIds, base, params, scene)

  return {
    query: options.query,
    results,
    count: results.length,
    source: scene ? 'semantic' : 'people',
    people,
    rankingQuery: intent.keywords,
    replayPlan: intent,
  }
}
