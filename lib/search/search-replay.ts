import { rankingDocuments } from './search-evidence'
import { applySearchQuality } from './search-quality'
import { SEARCH_VERSION, searchCacheKey } from './search-session'
import {
  databaseContext,
  type DatabaseIdentity,
  withServiceDatabase,
} from '../database/database-context'
import { runSearchWork } from './search-admission'
import { pgQuery } from '../postgres'
import { search, searchInterpreted, type SearchOptions } from '../search'
import { validateIntent } from './search-intent'
import { peopleById } from '../people/people-search'

/** Refresh stale popular searches before a rerank-only job. Replay runs through
 * the ordinary database credential with a conservative read-only user identity;
 * maintenance access is used only to enumerate private work, never to retrieve
 * candidate photos or names. No paid interpretation is triggered during replay. */
export async function refreshSavedSearches(limit: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const rows = await withServiceDatabase(
    () =>
      pgQuery<{
        id: string
        username: string
        kind: 'photo' | 'event'
        options: SearchOptions
        payload: Record<string, unknown>
      }>(
        `SELECT id,username,kind,options,payload FROM search_sessions
  WHERE options->>'searchVersion'=$2 AND expires_at>now() AND payload->>'exactPaging' IS DISTINCT FROM 'true' AND scope_revision IS DISTINCT FROM search_scope_revision(scope_ids,username)
  ORDER BY hits DESC,last_used_at DESC LIMIT $1`,
        [Math.min(limit, 20), String(SEARCH_VERSION)],
      ),
    signal,
  )
  let refreshed = 0
  for (const row of rows) {
    signal?.throwIfAborted()
    // Never reuse privileged role flags from a saved request. Ordinary ownership and
    // current sharing rules are sufficient; an admin's wider search refreshes live.
    const identity: DatabaseIdentity = {
      username: row.username,
      mainAdmin: false,
      adminRead: false,
      adminWrite: false,
      canWrite: false,
      accessManager: false,
    }
    await databaseContext.run(
      {
        kind: 'request',
        signal,
        identity: Promise.resolve(identity),
      },
      async () => {
        const [user] = await pgQuery(
          `SELECT name FROM photo_security.native_app_identity($1)
           WHERE enabled AND NOT revoked AND app_role IS NOT NULL`,
          [row.username],
        )
        if (!user) return
        const albums = (await pgQuery<{ event_id: number }>('SELECT event_id FROM events')).map(
          (x) => x.event_id,
        )
        const [version] = await pgQuery<{ revision: string }>(
          'SELECT search_scope_revision($1::int[]) AS revision',
          [albums],
        )
        const scope = (row.options as SearchOptions & { scopeIds?: number[] }).scopeIds
        if (!scope || scope.some((id) => !albums.includes(id))) return
        const options = { ...row.options, limit: 1000, interpretationAllowed: false }
        const didRefresh = await runSearchWork(
          identity,
          JSON.stringify([
            'replay',
            row.id,
            version.revision,
            searchCacheKey(row.kind, options, albums),
          ]),
          async () => {
            const selected = await peopleById(options.people ?? []).catch(() => null)
            if (!selected) return false
            const plan = row.payload.replayPlan
            const retrieved = plan
              ? await searchInterpreted(row.kind, options, albums, selected, validateIntent(plan))
              : await search(row.kind, options, albums)
            const result = applySearchQuality(retrieved, options.includeRelated)
            if ('clarification' in result && result.clarification) return false
            const ids = result.results.map((p) =>
              Number(p[row.kind === 'photo' ? 'photoId' : 'eventId']),
            )
            const documents = rankingDocuments(
              result.source === 'people' ? [] : result.results,
              options.query,
              row.kind === 'photo' ? 'photoId' : 'eventId',
            )
            const { results: _, ...payload } = result
            const updated = await pgQuery(
              `UPDATE search_sessions
    SET candidate_ids=$2::int[],documents=$3::jsonb,payload=$4::jsonb,scope_revision=$5,
      scope_ids=$9::int[],cache_key=$6,options=$7::jsonb,reranked_ids=NULL,rerank_status=$8,
      claim_token=NULL,attempts=0
    WHERE id=$1 AND $5::text=search_scope_revision($9::int[]) RETURNING id`,
              [
                row.id,
                ids,
                JSON.stringify(documents),
                JSON.stringify(payload),
                version.revision,
                searchCacheKey(row.kind, options, albums),
                JSON.stringify({ ...row.options, scopeIds: albums, searchVersion: SEARCH_VERSION }),
                documents.length > 1 ? 'queued' : 'skipped',
                albums,
              ],
            )
            return updated.length > 0
          },
        )
        if (didRefresh) refreshed++
      },
    )
  }
  return refreshed
}
