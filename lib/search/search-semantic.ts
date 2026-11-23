import type { SearchOptions } from './search-options'
import { searchProviderMatches } from './search-provider-results'
import { searchPartitionConcurrency } from './search-eligibility'
import { databaseContext, databaseSignal } from '../database/database-context'
import { deployment } from '../../config/deployment.mjs'
import { getRestApiAuthHeader, getSnowflakeBaseUrl, querySnowflake } from '../snowflake'
import { HttpError } from '../http'

export async function semanticMatches(
  kind: 'photo' | 'event',
  options: SearchOptions,
  allowedIds: number[],
  eligiblePhotoIds?: number[],
): Promise<Map<number, Record<string, number>>> {
  databaseSignal()?.throwIfAborted()
  if (options.exactWindow?.only)
    throw new HttpError(409, 'Search requirements changed. Search again.')
  if (!allowedIds.length || eligiblePhotoIds?.length === 0) return new Map()
  // Partition the eligibility filter, never truncate it. Each partition competes on the
  // same query; all returned candidates remain available to the caller for fusion.
  if (eligiblePhotoIds && eligiblePhotoIds.length > 5000) {
    const combined = new Map<number, Record<string, number>>()
    const concurrency = searchPartitionConcurrency()
    for (let start = 0; start < eligiblePhotoIds.length; start += 5000 * concurrency) {
      const parts = []
      for (
        let offset = start;
        offset < Math.min(start + 5000 * concurrency, eligiblePhotoIds.length);
        offset += 5000
      )
        parts.push(
          semanticMatches(kind, options, allowedIds, eligiblePhotoIds.slice(offset, offset + 5000)),
        )
      // Drain sibling calls before releasing admission capacity on failure.
      const settled = await Promise.allSettled(parts)
      databaseSignal()?.throwIfAborted()
      for (const part of settled) {
        if (part.status === 'rejected') throw part.reason
        for (const [id, scores] of part.value) combined.set(id, scores)
      }
    }
    return new Map(
      [...combined].sort(
        (a, b) => (b[1].reranker_score ?? -Infinity) - (a[1].reranker_score ?? -Infinity),
      ),
    )
  }
  const column = kind === 'photo' ? 'PHOTO_ID' : 'EVENT_ID'
  const service =
    kind === 'photo' ? deployment.PHOTO_SEARCH_SERVICE : deployment.EVENT_SEARCH_SERVICE
  const payload = {
    query: options.query,
    columns: [column],
    limit: Math.min(options.limit, 1000),
    filter: {
      '@or': (options.eventId ? [options.eventId] : allowedIds).map((id) => ({
        '@eq': { EVENT_ID: id },
      })),
    },
  }
  if (eligiblePhotoIds) {
    Object.assign(payload, {
      filter: {
        '@and': [
          payload.filter,
          { '@or': eligiblePhotoIds.map((id) => ({ '@primarykey': { PHOTO_ID: String(id) } })) },
        ],
      },
    })
  }
  const base = getSnowflakeBaseUrl()
  const authorization = getRestApiAuthHeader()
  let providerResponse: unknown
  if (base && authorization !== 'Bearer ') {
    // Cortex REST avoids a SQL query just to invoke search in the deployed service.
    const response = await fetch(
      `${base.replace(/\/$/, '')}/api/v2/databases/${deployment.DATABASE}/schemas/${deployment.DATA_SCHEMA}/cortex-search-services/${service}:query`,
      {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'X-Snowflake-Authorization-Token-Type': 'OAUTH',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: (() => {
          const ctx = databaseContext.getStore()
          const timeout = AbortSignal.timeout(15000)
          return ctx?.kind === 'request' && ctx.signal
            ? AbortSignal.any([timeout, ctx.signal])
            : timeout
        })(),
        cache: 'no-store',
      },
    )
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      databaseSignal()?.throwIfAborted()
      throw new HttpError(503, 'Search by meaning is temporarily unavailable')
    }
    try {
      providerResponse = await response.json()
    } catch (error) {
      databaseSignal()?.throwIfAborted()
      if (!(error instanceof SyntaxError)) throw error
      throw new HttpError(503, 'Search by meaning returned an invalid response')
    }
    databaseSignal()?.throwIfAborted()
  } else if (process.env.NODE_ENV === 'development') {
    // Existing local CLI authentication may not supply a REST OAuth token.
    const rows = await querySnowflake(
      `SELECT PARSE_JSON(SNOWFLAKE.CORTEX.SEARCH_PREVIEW('${deployment.DATABASE}.${deployment.DATA_SCHEMA}.${service}', ?)) AS RESULTS`,
      { binds: [JSON.stringify(payload)] },
    )
    providerResponse = rows[0]?.RESULTS
  } else {
    throw new HttpError(503, 'Search by meaning is not configured')
  }
  return searchProviderMatches(providerResponse, column)
}
