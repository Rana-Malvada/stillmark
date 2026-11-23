import { exactSearchCursor, type ExactWindow, readExactSearchCursor } from '../exact-search-page'
import {
  pruneViewerSearchSessionsSql,
  shouldTouchSearchSession,
} from './search-session-maintenance'
import { guardedBatchOrder, rankingDocuments } from './search-evidence'
import { applySearchQuality } from './search-quality'
import { validateIntent } from './search-intent'
import { peopleById, suggestPeople } from '../people/people-search'
import { createHash } from 'node:crypto'
import { getDatabaseIdentity, pgQuery } from '../postgres'
import { runSearchWork } from './search-admission'
import { hydrateSearchIds, search, searchInterpreted, searchOptions } from '../search'
import { HttpError, integer } from '../http'
import { flagOn } from '../flags'

const CANDIDATES = 1000
export const SEARCH_VERSION = 12
export interface SavedSearch {
  id: string
  last_used_at: string
  revision: string
  options: Partial<import('../search').SearchOptions> & {
    scopeIds?: number[]
    searchVersion?: number
  }
  candidate_ids: number[]
  reranked_ids: number[] | null
  documents: { id: number; evidenceTier?: number; retrievalTier?: number; formatVersion?: number }[]
  payload: Record<string, unknown> & {
    people: import('../people/people-search').PersonMatch[]
    source: string
  }
}
/** Retrieval needs ranking tiers, never the large OCR/description documents. */
export function savedSearchColumns(batchEnabled: boolean): string {
  const documents = batchEnabled
    ? `CASE WHEN reranked_ids IS NOT NULL THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', d->'id', 'evidenceTier', d->'evidenceTier',
        'retrievalTier', d->'retrievalTier', 'formatVersion', d->'formatVersion'
      )), '[]'::jsonb) FROM jsonb_array_elements(documents) AS d)
      ELSE '[]'::jsonb END`
    : "'[]'::jsonb"
  return `id, last_used_at, scope_revision AS revision, options, candidate_ids, reranked_ids, payload, ${documents} AS documents`
}
async function revision(scopeIds: number[]) {
  return String(
    (
      await pgQuery<{ revision: string }>('SELECT search_scope_revision($1::int[]) AS revision', [
        scopeIds,
      ])
    )[0].revision,
  )
}
export function searchCacheKey(
  kind: 'photo' | 'event',
  options: import('../search').SearchOptions,
  allowedIds: number[],
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: SEARCH_VERSION,
        kind,
        query: options.query,
        relativeDate: /\b(today|yesterday|last|this|next|ago)\b/i.test(options.query)
          ? new Date().toISOString().slice(0, 10)
          : null,
        semantic: options.semantic,
        related: options.includeRelated ?? false,
        event: options.eventId,
        people: [...(options.people ?? [])].sort(),
        albums: [...allowedIds].sort((a, b) => a - b),
      }),
    )
    .digest('hex')
}
/** Session rows are caller-owned under forced RLS. Cached IDs are not an access grant. */
export async function pagedSearch(kind: 'photo' | 'event', req: Request, allowedIds: number[]) {
  const columns = savedSearchColumns(flagOn('SEARCH_BATCH_RANKING_ENABLED'))
  const options = searchOptions(req)
  const params = new URL(req.url).searchParams
  const cursor = params.get('cursor')
  const exactCursor = cursor?.startsWith('x:') ? readExactSearchCursor(cursor) : null
  const exactWindow: ExactWindow = { limit: options.limit }
  const current = await revision(allowedIds)
  let saved: SavedSearch | undefined
  let offset = 0
  let cacheHit = false
  if (cursor) {
    const match = exactCursor
      ? [cursor, exactCursor.session, String(exactCursor.seen)]
      : /^([a-f0-9-]{36}):(\d+)$/.exec(cursor)
    if (!match) throw new HttpError(400, 'Invalid search cursor')
    offset = integer(match[2], 'offset', 0, Number.MAX_SAFE_INTEGER)
    saved = (
      await pgQuery<SavedSearch>(
        `SELECT ${columns} FROM search_sessions WHERE id=$1::uuid AND kind=$2 AND expires_at>now()`,
        [match[1], kind],
      )
    )[0]
    if (
      !saved ||
      saved.options.searchVersion !== SEARCH_VERSION ||
      String(saved.revision) !== current ||
      !saved.options.scopeIds ||
      saved.options.scopeIds.some((id) => !allowedIds.includes(id))
    )
      throw new HttpError(409, 'Your library changed. Search again to refresh these results.')
  } else {
    const key = searchCacheKey(kind, options, allowedIds)
    saved = (
      await pgQuery<SavedSearch>(
        `SELECT ${columns} FROM search_sessions WHERE cache_key=$1 AND scope_revision=$2 AND expires_at>now() ORDER BY last_used_at DESC LIMIT 1`,
        [key, current],
      )
    )[0]
    if (saved) cacheHit = true
    if (saved) {
      if (shouldTouchSearchSession(saved.last_used_at))
        await pgQuery(
          "UPDATE search_sessions SET hits=hits+1,last_used_at=now() WHERE id=$1 AND last_used_at<=now()-interval '1 minute'",
          [saved.id],
        )
    } else {
      const identity = await getDatabaseIdentity()
      const shared = await runSearchWork(
        identity,
        JSON.stringify(['interactive', key, current, options.limit]),
        async () => {
          // Another admitted search may have filled this cache while we waited.
          const [cached] = await pgQuery<SavedSearch>(
            `SELECT ${columns} FROM search_sessions WHERE cache_key=$1 AND scope_revision=$2 AND expires_at>now() ORDER BY last_used_at DESC LIMIT 1`,
            [key, current],
          )
          const exactWindow: ExactWindow = { limit: options.limit }
          if (cached) return { saved: cached, exactWindow, cached: true }
          if ((await revision(allowedIds)) !== current)
            throw new HttpError(409, 'Your library changed. Search again to refresh these results.')
          // A changed catalog does not change the meaning of the same query. Reuse
          // a recent validated interpretation, then resolve names/permissions again.
          const [history] = await pgQuery<{ payload: { replayPlan?: unknown } }>(
            `SELECT jsonb_build_object('replayPlan',payload->'replayPlan') AS payload FROM search_sessions WHERE cache_key=$1 AND expires_at>now()
        AND created_at>now()-interval '24 hours' AND payload ? 'replayPlan' ORDER BY created_at DESC LIMIT 1`,
            [key],
          )
          const retrieved =
            history?.payload.replayPlan && !options.people?.length
              ? {
                  ...(await searchInterpreted(
                    kind,
                    { ...options, limit: CANDIDATES, deferExactHydration: true, exactWindow },
                    allowedIds,
                    await peopleById(options.people ?? []),
                    validateIntent(history.payload.replayPlan),
                  )),
                  suggestions: await suggestPeople(options.query, allowedIds),
                  interpretation: null,
                }
              : await search(
                  kind,
                  { ...options, limit: CANDIDATES, deferExactHydration: true, exactWindow },
                  allowedIds,
                )
          const result = applySearchQuality(retrieved, options.includeRelated)
          const ids = result.results.map((row) =>
            Number(row[kind === 'photo' ? 'photoId' : 'eventId']),
          )
          const { results: _, ...metadata } = result
          const payload = {
            ...metadata,
            ...(exactWindow.used ? { exactPaging: true } : {}),
            rankScores: Object.fromEntries(
              result.results.map((row) => [
                Number(row[kind === 'photo' ? 'photoId' : 'eventId']),
                { scores: row.scores, keywordScore: row.keywordScore },
              ]),
            ),
          }
          // Persist only evidence already returned under the searcher's RLS. Face names
          // stay in the private query/plan; never add them to globally indexed text.
          const documents = rankingDocuments(
            result.source === 'people' ? [] : result.results,
            options.query,
            kind === 'photo' ? 'photoId' : 'eventId',
          )
          const saved = (
            await pgQuery<SavedSearch>(
              `INSERT INTO search_sessions(cache_key,kind,query,options,revision,scope_revision,payload,candidate_ids,documents,rerank_status,scope_ids)
        VALUES($1,$2,$3,$4::jsonb,0,$5,$6::jsonb,$7::int[],$8::jsonb,$9,$10::int[]) RETURNING ${columns}`,
              [
                key,
                kind,
                options.query,
                JSON.stringify({ ...options, scopeIds: allowedIds, searchVersion: SEARCH_VERSION }),
                current,
                JSON.stringify(payload),
                ids,
                JSON.stringify(documents),
                ids.length > 1 && result.source !== 'people' ? 'queued' : 'skipped',
                allowedIds,
              ],
            )
          )[0]
          await pgQuery(pruneViewerSearchSessionsSql)
          return { saved, exactWindow, cached: false }
        },
      )
      saved = shared.saved
      cacheHit = shared.cached
      Object.assign(exactWindow, shared.exactWindow)
    }
  }
  if (saved.payload.exactPaging === true) {
    if (cursor && !exactCursor) throw new HttpError(400, 'Invalid search cursor')
    if (!exactWindow.used) {
      // Stored options are data, not SQL or an authorization grant. Revalidate
      // them and rebuild constraints under the current viewer's row security.
      const stored = saved.options
      const replayParams = new URLSearchParams({
        q: typeof stored.query === 'string' ? stored.query : '',
        mode: stored.semantic === true ? 'semantic' : 'auto',
        limit: String(options.limit),
      })
      if (stored.eventId != null) replayParams.set('eventId', String(stored.eventId))
      if (Array.isArray(stored.people))
        for (const person of stored.people) replayParams.append('person', person)
      const replay = {
        ...searchOptions(new Request('https://internal/search?' + replayParams)),
        interpretationAllowed: false,
        deferExactHydration: true,
        exactWindow,
      }
      exactWindow.only = true
      exactWindow.after = exactCursor?.position
      if (saved.payload.replayPlan) {
        await searchInterpreted(
          kind,
          replay,
          allowedIds,
          await peopleById(replay.people ?? []),
          validateIntent(saved.payload.replayPlan),
        )
      } else await search(kind, replay, allowedIds)
      if (!exactWindow.used) throw new HttpError(409, 'Search requirements changed. Search again.')
    }
    const results = await hydrateSearchIds(kind, exactWindow.ids ?? [], allowedIds)
    if ((await revision(allowedIds)) !== current)
      throw new HttpError(409, 'Your library changed. Search again to refresh these results.')
    const { rankScores: _, exactPaging: __, ...metadata } = saved.payload
    return {
      ...metadata,
      results,
      count: results.length,
      candidateCount: offset + results.length + (exactWindow.more ? 1 : 0),
      countIsExact: !exactWindow.more,
      countIsLowerBound: !!exactWindow.more,
      nextCursor: exactWindow.next
        ? exactSearchCursor(saved.id, exactWindow.next, offset + results.length)
        : null,
      interpretation: cacheHit || cursor ? null : saved.payload.interpretation,
      ranking: 'live',
      cached: !!cursor || cacheHit,
    }
  }
  if (exactCursor) throw new HttpError(400, 'Invalid search cursor')
  // Freeze ordering across pages. Completed batch order is used on a new search;
  // a cursor continues the original candidate ordering unless it explicitly chose it.
  const batch =
    flagOn('SEARCH_BATCH_RANKING_ENABLED') &&
    !!saved.reranked_ids &&
    !!saved.documents?.length &&
    saved.documents.every((d) => d.formatVersion === 2) &&
    (!cursor || params.get('ranking') === 'batch')
  const allIds = batch
    ? guardedBatchOrder(saved.candidate_ids, saved.reranked_ids!, saved.documents ?? [])
    : saved.candidate_ids
  const slice = allIds.slice(offset, offset + options.limit)
  const results = await hydrateSearchIds(kind, slice, allowedIds)
  const changed = (await revision(allowedIds)) !== current
  if (changed && cursor)
    throw new HttpError(409, 'Your library changed. Search again to refresh these results.')
  const { rankScores, ...metadata } = saved.payload
  const scoring = (rankScores ?? {}) as Record<
    string,
    { scores?: Record<string, number>; keywordScore?: number }
  >
  return {
    ...metadata,
    ...(changed
      ? {
          people: [],
          suggestions: [],
          notice: 'Your library changed during this search. Search again to refresh all matches.',
        }
      : {}),
    interpretation: cacheHit || cursor ? null : saved.payload.interpretation,
    results: results.map((row): Record<string, unknown> => ({
      ...row,
      ...scoring[String(row[kind === 'photo' ? 'photoId' : 'eventId'])],
    })),
    count: results.length,
    candidateCount: changed ? results.length : allIds.length,
    countIsExact: !changed && saved.payload.source === 'people',
    nextCursor:
      !changed && offset + options.limit < allIds.length
        ? `${saved.id}:${offset + options.limit}`
        : null,
    ranking: batch ? 'batch' : 'live',
    cached: !!cursor || cacheHit,
  }
}
