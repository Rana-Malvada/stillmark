// Eligibility, bounded ranking and live hydration; every result keeps its hard filters.
import type { SearchOptions } from './search-options'
import { semanticMatches } from './search-semantic'
import { hasSearchEvidence } from './search-quality'
import {
  type EligibleMatch,
  searchPartitionConcurrency,
  withEligibleMatches,
  withFusedMatches,
} from './search-eligibility'
import { SearchSortBuffer } from './search-sort-buffer'
import { databaseSignal } from '../database/database-context'
import { candidateBatches, hydrateRankedCandidates } from './search-hydration'
import {
  allowsVisualSearch,
  identifierRequirements,
  literalSearchQuery,
  prioritizePhotoEvidence,
  protectEvidence,
  supportedEvidence,
} from './search-evidence'
import { visualMatches } from './visual-search'
import { pgQuery } from '../postgres'
import { HttpError } from '../http'
import { EVENT_SELECT, PHOTO_SELECT, subjectSelect, withCoverUrls } from './query'

/** Hard constraints are applied BEFORE retrieval and again when hydrating. */
export async function retrieveEligible(
  kind: 'photo' | 'event',
  options: SearchOptions,
  allowedIds: number[],
  base: string,
  params: unknown[],
  scene: string,
): Promise<Record<string, unknown>[]> {
  if (options.exactWindow?.only && scene)
    throw new HttpError(409, 'Search requirements changed. Search again.')
  if (!scene && options.exactWindow) {
    const window = options.exactWindow
    const values = [...params]
    const bind = (value: unknown, type: string) => `$${values.push(value)}::${type}`
    const after = window.after
    const boundary = after
      ? `AND (COALESCE(cursor_date,'-infinity'::timestamptz),cursor_id)<(COALESCE(${bind(after.date, 'timestamptz')},'-infinity'::timestamptz),${bind(after.id, 'int')})`
      : ''
    const source =
      kind === 'photo'
        ? `SELECT p.photo_id AS "photoId",p.event_id AS "eventId",p.date_taken AS cursor_date,p.photo_id AS cursor_id FROM photos p JOIN events e ON e.event_id=p.event_id WHERE ${base}`
        : `SELECT p.event_id AS "eventId",max(p.date_taken) AS cursor_date,max(p.photo_id) AS cursor_id FROM photos p JOIN events e ON e.event_id=p.event_id WHERE ${base} GROUP BY p.event_id`
    const rows = await pgQuery<
      Record<string, unknown> & { cursor_date: string | null; cursor_id: number }
    >(
      `SELECT exact_rows.*,cursor_date::text AS cursor_date
       FROM (${source}) exact_rows
       WHERE TRUE ${boundary}
       ORDER BY exact_rows.cursor_date DESC NULLS LAST,exact_rows.cursor_id DESC
       LIMIT ${bind(window.limit + 1, 'int')}`,
      values,
    )
    window.used = true
    window.more = rows.length > window.limit
    const page = rows.slice(0, window.limit)
    const last = page.at(-1)
    window.next =
      window.more && last ? { date: last.cursor_date, id: Number(last.cursor_id) } : null
    window.ids = page.map((row) => Number(row[kind === 'photo' ? 'photoId' : 'eventId']))
    return page.map(({ cursor_date: _, cursor_id: __, ...row }) => row)
  }
  if (!scene && options.deferExactHydration) {
    // Keep the complete exact candidate set, but do not load every description,
    // metadata record and image path merely to select the first displayed page.
    if (kind === 'photo')
      return pgQuery(
        `SELECT p.photo_id AS "photoId",p.event_id AS "eventId" FROM photos p JOIN events e ON e.event_id=p.event_id WHERE ${base} ORDER BY p.date_taken DESC NULLS LAST,p.photo_id DESC`,
        params,
      )
    return pgQuery(
      `SELECT p.event_id AS "eventId" FROM photos p JOIN events e ON e.event_id=p.event_id WHERE ${base} GROUP BY p.event_id ORDER BY max(p.date_taken) DESC NULLS LAST,max(p.photo_id) DESC`,
      params,
    )
  }
  let ids: number[] = []
  if (!scene) {
    const eligible = await pgQuery<{ photoId: number }>(
      `SELECT p.photo_id AS "photoId" FROM photos p JOIN events e ON e.event_id=p.event_id WHERE ${base}`,
      params,
    )
    ids = eligible.map((p) => p.photoId)
    if (!ids.length) return []
  }
  if (scene) {
    const literalQuery = literalSearchQuery(options.query)
    const keywords = await pgQuery<{ photoId: number }>(
      `SELECT p.photo_id AS "photoId" FROM photos p JOIN events e ON e.event_id=p.event_id
      WHERE ${base} AND p.search_vector @@ websearch_to_tsquery('english',$${params.length + 1}::text)
      ORDER BY ts_rank_cd(p.search_vector,websearch_to_tsquery('english',$${params.length + 1}::text)) DESC,p.photo_id
      LIMIT $${params.length + 2}::int`,
      [...params, literalQuery || scene, options.limit],
    )
    const lexicalIds = new Set(keywords.map((row) => row.photoId))
    const literalRequired = identifierRequirements(options.query).length > 0
    const hydrate = async (candidates: AsyncIterable<EligibleMatch>) => {
      const load = async (batch: EligibleMatch[]): Promise<Record<string, unknown>[]> => {
        const scores = new Map(batch.map((row) => [row.id, row.scores]))
        const rows = await pgQuery(
          `${subjectSelect(`$${params.length + 2}::text`)} WHERE ${base} AND p.photo_id=ANY($${params.length + 1}::int[]) ORDER BY array_position($${params.length + 1}::int[],p.photo_id)`,
          [...params, batch.map((row) => row.id), scene],
        )
        return rows.map((row) => ({
          ...row,
          scores: scores.get(Number(row.photoId)) ?? {},
          keywordMatch: lexicalIds.has(Number(row.photoId)) || literalRequired,
        }))
      }
      if (kind === 'photo')
        return hydrateRankedCandidates(
          options.query,
          candidates,
          options.limit,
          load,
          databaseSignal(),
        )
      const events = new Map<number, Record<string, unknown>>()
      for await (const batch of candidateBatches(candidates, databaseSignal())) {
        const rows = await load(batch)
        for (const row of supportedEvidence(options.query, rows)) {
          const eventId = Number(row.eventId)
          const evidence = {
            eventId,
            scores: row.scores,
            subjectMatch: row.subjectMatch,
            keywordMatch: row.keywordMatch,
          }
          const existing = events.get(eventId)
          if (!existing || (!hasSearchEvidence(existing) && hasSearchEvidence(evidence)))
            events.set(eventId, evidence)
        }
      }
      if (!events.size) return []
      return withCoverUrls(
        await pgQuery(
          `${EVENT_SELECT} WHERE e.event_id=ANY($1::int[]) ORDER BY array_position($1::int[],e.event_id)`,
          [[...events.keys()]],
        ),
      ).map((event) => ({ ...event, ...events.get(Number(event.eventId)) }))
    }
    const fuseAndHydrate = async (matches: SearchSortBuffer<EligibleMatch>) => {
      const visual = allowsVisualSearch(scene)
        ? await visualMatches(scene, allowedIds, undefined, options.limit, {
            where: base,
            params,
          }).catch(() => {
            databaseSignal()?.throwIfAborted()
            return []
          })
        : []
      return withFusedMatches(matches, [...lexicalIds], visual, hydrate, databaseSignal())
    }
    let retrievalComplete = false
    try {
      return await withEligibleMatches(
        async (after, limit) =>
          (
            await pgQuery<{ photoId: number }>(
              `SELECT p.photo_id AS "photoId" FROM photos p JOIN events e ON e.event_id=p.event_id WHERE ${base} AND p.photo_id>$${params.length + 1}::int ORDER BY p.photo_id LIMIT $${params.length + 2}::int`,
              [...params, after, limit],
            )
          ).map((row) => row.photoId),
        (pageIds) =>
          semanticMatches(
            'photo',
            { ...options, query: scene, limit: Math.max(options.limit, 200) },
            allowedIds,
            pageIds,
          ),
        searchPartitionConcurrency(),
        (matches) => {
          retrievalComplete = true
          return fuseAndHydrate(matches)
        },
        databaseSignal(),
      )
    } catch (error) {
      databaseSignal()?.throwIfAborted()
      // Preserve lexical fallback only for retrieval failure, never hide a failed
      // hydration or rank fusion as a successful partial search.
      if (retrievalComplete || !keywords.length) throw error
      const empty = new SearchSortBuffer<EligibleMatch>(() => 0, databaseSignal())
      try {
        return await fuseAndHydrate(empty)
      } finally {
        await empty.dispose()
      }
    }
  }

  const idParam = `$${params.length + 1}::int[]`
  const photos = await pgQuery(
    `${PHOTO_SELECT} WHERE ${base} AND p.photo_id=ANY(${idParam}) ORDER BY p.date_taken DESC NULLS LAST,p.photo_id DESC`,
    [...params, ids],
  )
  if (kind === 'photo')
    return supportedEvidence(
      options.query,
      protectEvidence(options.query, prioritizePhotoEvidence(photos)),
    )

  const events = [...new Set(photos.map((p) => Number(p.eventId)))]
  return withCoverUrls(
    await pgQuery(
      `${EVENT_SELECT} WHERE e.event_id=ANY($1::int[]) ORDER BY array_position($1::int[],e.event_id)`,
      [events],
    ),
  )
}

/** Every saved-result page is rehydrated under the caller's live row security. */
export async function hydrateSearchIds(
  kind: 'photo' | 'event',
  ids: number[],
  allowedIds: number[],
) {
  if (!ids.length || !allowedIds.length) return []
  if (kind === 'photo')
    return pgQuery(
      `${PHOTO_SELECT} WHERE p.photo_id=ANY($1::int[]) AND p.event_id=ANY($2::int[]) AND p.ingest_status='READY' ORDER BY array_position($1::int[],p.photo_id)`,
      [ids, allowedIds],
    )
  return withCoverUrls(
    await pgQuery(
      `${EVENT_SELECT} WHERE e.event_id=ANY($1::int[]) AND e.event_id=ANY($2::int[]) ORDER BY array_position($1::int[],e.event_id)`,
      [ids, allowedIds],
    ),
  )
}

/** Album-only predicates must also match empty albums. Cursor ordering is shared
 * with the saved search protocol, using album creation time for this domain. */
export async function retrieveAlbums(options: SearchOptions, where: string, params: unknown[]) {
  const values = [...params]
  const bind = (value: unknown, type: string) => `$${values.push(value)}::${type}`
  const window = options.exactWindow
  const after = window?.after
  const boundary = after
    ? ` AND (coalesce(e.created_at,'-infinity'::timestamptz),e.event_id)<(coalesce(${bind(after.date, 'timestamptz')},'-infinity'::timestamptz),${bind(after.id, 'int')})`
    : ''
  const rows = await pgQuery<
    Record<string, unknown> & { eventId: number; cursor_date: string | null }
  >(
    `SELECT e.event_id AS "eventId",e.created_at::text AS cursor_date
     FROM events e
     WHERE ${where}${boundary}
     ORDER BY e.created_at DESC NULLS LAST,e.event_id DESC${window ? ' LIMIT ' + bind(window.limit + 1, 'int') : ''}`,
    values,
  )
  if (window) {
    window.used = true
    window.more = rows.length > window.limit
    const page = rows.slice(0, window.limit)
    const last = page.at(-1)
    window.next = window.more && last ? { date: last.cursor_date, id: last.eventId } : null
    window.ids = page.map((r) => r.eventId)
    return page.map(({ cursor_date: _, ...row }) => row)
  }
  return hydrateSearchIds(
    'event',
    rows.map((row) => row.eventId),
    params[0] as number[],
  )
}
