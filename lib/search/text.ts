// Free-text lexical/semantic retrieval, including evidence-preserving fallback.
import type { SearchOptions } from './search-options'
import { semanticMatches } from './search-semantic'
import { cleanScene, fuseSearchRanks } from './search-ranking'
import { databaseSignal } from '../database/database-context'
import {
  allowsVisualSearch,
  literalSearchQuery,
  prioritizePhotoEvidence,
  protectEvidence,
  supportedEvidence,
} from './search-evidence'
import { visualMatches } from './visual-search'
import { pgQuery } from '../postgres'
import { EVENT_SELECT, PHOTO_SELECT, subjectSelect, withCoverUrls } from './query'

export async function searchText(
  kind: 'photo' | 'event',
  options: SearchOptions,
  allowedIds: number[],
) {
  if (!options.query) return { query: '', results: [], count: 0, source: 'postgres' }
  let results: Record<string, unknown>[] = []
  const literalQuery = kind === 'photo' ? literalSearchQuery(options.query) : ''
  if (!options.semantic || literalQuery) {
    results =
      kind === 'photo'
        ? await pgQuery(
            `${PHOTO_SELECT.replace('SELECT ', 'SELECT ts_rank_cd(p.search_vector, websearch_to_tsquery(\'english\', $1)) AS "keywordScore", ')}
          WHERE p.event_id=ANY($4::int[]) AND p.ingest_status='READY' AND ($3::int IS NULL OR p.event_id=$3)
          AND p.search_vector @@ websearch_to_tsquery('english', $1)
          ORDER BY ts_rank_cd(p.search_vector, websearch_to_tsquery('english', $1)) DESC, p.photo_id DESC LIMIT $2`,
            [literalQuery || options.query, options.limit, options.eventId, allowedIds],
          )
        : await pgQuery(
            `${EVENT_SELECT.replace('SELECT ', 'SELECT ts_rank_cd(e.search_vector, websearch_to_tsquery(\'english\', $1)) AS "keywordScore", ')}
          WHERE e.event_id=ANY($3::int[]) AND ($4::int IS NULL OR e.event_id=$4)
          AND e.search_vector @@ websearch_to_tsquery('english', $1)
          ORDER BY ts_rank_cd(e.search_vector, websearch_to_tsquery('english', $1)) DESC, e.event_id DESC LIMIT $2`,
            [options.query, options.limit, allowedIds, options.eventId],
          )
  }
  let source = 'postgres'
  if (options.semantic || results.length === 0 || options.query.trim().split(/\s+/).length > 1) {
    let matches: Map<number, Record<string, number>>
    try {
      matches = await semanticMatches(kind, options, allowedIds)
    } catch (error) {
      databaseSignal()?.throwIfAborted()
      if (!results.length) throw error
      matches = new Map()
    }
    const visual =
      kind === 'photo' && allowsVisualSearch(options.query)
        ? await visualMatches(
            options.query,
            options.eventId ? [options.eventId] : allowedIds,
            undefined,
            options.limit,
          ).catch(() => {
            databaseSignal()?.throwIfAborted()
            return []
          })
        : []
    const ids = fuseSearchRanks(
      [
        results.map((row) => Number(row[kind === 'photo' ? 'photoId' : 'eventId'])),
        [...matches.keys()],
      ],
      visual,
    )
    const keywordRows = results
    // Hydrate from Postgres: deleted/stale semantic documents can never expose removed media.
    if (ids.length)
      results =
        kind === 'photo'
          ? await pgQuery(
              `${subjectSelect('$4::text')} WHERE p.event_id=ANY($3::int[]) AND p.photo_id=ANY($1::int[]) AND p.ingest_status='READY' AND ($2::int IS NULL OR p.event_id=$2)
          ORDER BY array_position($1::int[], p.photo_id)`,
              [ids, options.eventId, allowedIds, cleanScene(options.query)],
            )
          : await pgQuery(
              `${EVENT_SELECT} WHERE e.event_id=ANY($1::int[]) AND e.event_id=ANY($2::int[]) ORDER BY array_position($1::int[], e.event_id)`,
              [ids, options.eventId ? [options.eventId] : allowedIds],
            )
    const keywordIds = new Set(
      keywordRows.map((row) => Number(row[kind === 'photo' ? 'photoId' : 'eventId'])),
    )
    results = results.map((row) => ({
      ...(keywordIds.has(Number(row[kind === 'photo' ? 'photoId' : 'eventId']))
        ? { keywordMatch: true }
        : {}),
      ...row,
      scores: matches.get(Number(row[kind === 'photo' ? 'photoId' : 'eventId'])) ?? {},
    }))
    source = 'semantic'
  }
  if (kind === 'photo')
    results = supportedEvidence(
      options.query,
      protectEvidence(options.query, prioritizePhotoEvidence(results)),
    )
  if (kind === 'photo' && literalQuery)
    results = results.map((row) => ({ ...row, keywordMatch: true }))
  if (kind === 'event') results = withCoverUrls(results)
  return { query: options.query, results, count: results.length, source }
}
