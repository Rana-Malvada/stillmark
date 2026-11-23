import { expressionFromNodes } from './search-plan-schema'
import { type SearchExpression, validExpression } from './search-expression'
import { type MetadataFilter, validFilter } from './search-metadata'
import { interpretationRequest, SEARCH_INTERPRETATION_MODEL } from './search-interpretation-request'
import { getCallerIdentity } from '../identity/auth'
import { getServiceToken } from '../snowflake'
import { deployment } from '../../config/deployment.mjs'
import { costWork } from '../costs/cost-work'
import { beginRestCost, finishRestCost } from '../snowflake/cortex-rest-costs'
import { pgIndependent, pgQueryOne } from '../postgres'
import { HttpError } from '../http'
import { databaseContext, databaseSignal, withServiceDatabase } from '../database/database-context'
import { flagOn } from '../flags'

export interface SearchIntent {
  where?: SearchExpression
  // OR of branches, each requiring all included names and excluding all excluded names.
  branches: { include: string[]; exclude: string[] }[]
  keywords: string
  excludeMountainDestinations?: boolean
  metadata?: MetadataFilter[]
  place?: string | null
  alternativePlaces?: string[]
  excludedPlaces?: string[]
  excludedKeywords: string[]
  fromYear: number | null
  throughYear: number | null
  clarification: string | null
}
export interface Interpretation {
  intent: SearchIntent
  metrics: {
    mode: 'sonnet'
    elapsedMs: number
    inputTokens: number | null
    outputTokens: number | null
  }
}
/** Basic searches avoid paid interpretation. This routes requests; it does not parse their meaning. */
export function needsInterpretation(query: string, remainder: string, hasPeople: boolean) {
  const words = query.trim().split(/\s+/)
  if (!query.trim()) return false
  if (
    /\b(or|not|without|except|excluding|either|neither|only|before|after|between|since|until)\b/i.test(
      query,
    )
  )
    return true
  if (hasPeople && !remainder.replace(/\b(and|with)\b|[,&]/gi, '').trim()) return false
  return words.length > 4 || /\b(show|find|where|together|both|want|looking)\b/i.test(query)
}
export function validateIntent(value: unknown): SearchIntent {
  const fail = () => {
    throw new HttpError(502, 'Could not interpret this search safely. Please try again.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const v = value as Record<string, unknown>
  if ('nodes' in v) {
    if (Object.keys(v).some((key) => !['nodes', 'root', 'keywords', 'clarification'].includes(key)))
      return fail()
    try {
      return validateIntent({
        where: expressionFromNodes(v.nodes, v.root),
        keywords: v.keywords,
        clarification: v.clarification,
      })
    } catch {
      return fail()
    }
  }
  if ('where' in v) {
    // Saved plans contain the normalized empty legacy envelope. Reject any
    // meaningful legacy constraints rather than silently dropping them.
    if (
      Object.keys(v).some(
        (key) =>
          ![
            'where',
            'keywords',
            'clarification',
            'branches',
            'excludedKeywords',
            'fromYear',
            'throughYear',
          ].includes(key),
      ) ||
      (v.branches !== undefined &&
        (!Array.isArray(v.branches) ||
          v.branches.length !== 1 ||
          !v.branches[0] ||
          Object.keys(v.branches[0]).sort().join(',') !== 'exclude,include' ||
          !Array.isArray(v.branches[0].include) ||
          v.branches[0].include.length ||
          !Array.isArray(v.branches[0].exclude) ||
          v.branches[0].exclude.length)) ||
      (v.excludedKeywords !== undefined && JSON.stringify(v.excludedKeywords) !== '[]') ||
      (v.fromYear !== undefined && v.fromYear !== null) ||
      (v.throughYear !== undefined && v.throughYear !== null)
    )
      return fail()
    if (v.where !== null && !validExpression(v.where)) return fail()
    if (
      typeof v.keywords !== 'string' ||
      v.keywords.length > 300 ||
      !(
        v.clarification === null ||
        (typeof v.clarification === 'string' && v.clarification.length <= 300)
      )
    )
      return fail()
    if (!v.where && !v.keywords.trim() && !v.clarification) return fail()
    return {
      branches: [{ include: [], exclude: [] }],
      excludedKeywords: [],
      fromYear: null,
      throughYear: null,
      ...(v.where ? { where: v.where as SearchExpression } : {}),
      keywords: v.keywords.trim(),
      clarification: v.clarification as string | null,
    }
  }
  const strings = (x: unknown, max: number) => {
    if (
      !Array.isArray(x) ||
      x.length > max ||
      x.some((s) => typeof s !== 'string' || !s.trim() || s.length > 150)
    )
      return fail()
    return x.map((s) => s.trim()) as string[]
  }
  if (!Array.isArray(v.branches) || !v.branches.length || v.branches.length > 8) return fail()
  const branches = v.branches.map((b) => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return fail()
    return { include: strings(b.include, 5), exclude: strings(b.exclude, 5) }
  })
  if (typeof v.keywords !== 'string' || v.keywords.length > 300) return fail()
  const year = (x: unknown): number | null =>
    x === null
      ? null
      : Number.isInteger(x) && Number(x) >= 1 && Number(x) <= 9999
        ? Number(x)
        : fail()
  const fromYear = year(v.fromYear)
  const throughYear = year(v.throughYear)
  if (fromYear && throughYear && fromYear > throughYear) return fail()
  if (
    v.clarification !== null &&
    (typeof v.clarification !== 'string' || v.clarification.length > 300)
  )
    return fail()
  if (
    v.metadata !== undefined &&
    (!Array.isArray(v.metadata) || v.metadata.length > 12 || !v.metadata.every(validFilter))
  )
    return fail()
  if (
    v.excludeMountainDestinations !== undefined &&
    typeof v.excludeMountainDestinations !== 'boolean'
  )
    return fail()
  return {
    ...(v.excludeMountainDestinations === undefined
      ? {}
      : { excludeMountainDestinations: v.excludeMountainDestinations as boolean }),
    ...(v.metadata === undefined ? {} : { metadata: v.metadata as MetadataFilter[] }),
    branches,
    ...(v.place === undefined ? {} : { place: v.place === null ? null : strings([v.place], 1)[0] }),
    ...(v.alternativePlaces === undefined
      ? {}
      : { alternativePlaces: strings(v.alternativePlaces, 8) }),
    ...(v.excludedPlaces === undefined ? {} : { excludedPlaces: strings(v.excludedPlaces, 32) }),
    keywords: v.keywords.trim(),
    excludedKeywords: strings(v.excludedKeywords, 5),
    fromYear,
    throughYear,
    clarification: v.clarification as string | null,
  }
}
export async function interpretSearch(
  query: string,
  selectedNames: string[],
  kind: 'photo' | 'event' = 'photo',
): Promise<Interpretation> {
  const signal = databaseSignal()
  signal?.throwIfAborted()
  const context = databaseContext.getStore()
  // Shared search work carries only immutable, verified database identity.
  const caller =
    context?.kind === 'request' && context.identity
      ? await context.identity
      : await getCallerIdentity()
  if (flagOn('CUSTOMER_ACCOUNTS_ENABLED')) {
    const allowance = await pgQueryOne<{ allowed: boolean }>(
      'SELECT photo_security.admit_customer_search_ai() AS allowed',
    )
    if (!allowance?.allowed)
      throw new HttpError(
        429,
        'Daily search AI allowance reached. Basic text and semantic searches remain available.',
      )
  }
  const started = performance.now()
  // Only interpretation accounting uses maintenance access; photo/name queries stay caller-scoped.
  return withServiceDatabase(
    () =>
      costWork('search_ai', { [caller.username]: 1 }, async () => {
        const serviceToken = getServiceToken()
        const token = serviceToken || process.env.SNOWFLAKE_CORTEX_TOKEN
        if (!token) throw new HttpError(503, 'Search interpretation is temporarily unavailable.')
        const origin =
          serviceToken && process.env.SNOWFLAKE_HOST
            ? `https://${process.env.SNOWFLAKE_HOST}`
            : deployment.SNOWFLAKE_API_ORIGIN
        const id = await beginRestCost(SEARCH_INTERPRETATION_MODEL)
        const response = await fetch(`${origin}/api/v2/cortex/v1/messages`, {
          method: 'POST',
          redirect: 'error',
          cache: 'no-store',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
            : AbortSignal.timeout(30000),
          headers: {
            Authorization: `Bearer ${token}`,
            ...(serviceToken ? { 'X-Snowflake-Authorization-Token-Type': 'OAUTH' } : {}),
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            Accept: 'application/json',
          },
          body: JSON.stringify(interpretationRequest(query, selectedNames, kind)),
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          signal?.throwIfAborted()
          throw new HttpError(
            503,
            'Search interpretation is temporarily unavailable. Please retry.',
          )
        }
        const result = await response.json()
        const usage = result.usage
        await finishRestCost(
          id,
          SEARCH_INTERPRETATION_MODEL,
          usage,
          response.headers.get('x-snowflake-request-id') ||
            response.headers.get('request-id') ||
            result.request_id ||
            result.id,
        )
        const elapsedMs = Math.round(performance.now() - started)
        await pgIndependent(
          "UPDATE cost_rest_requests SET usage=COALESCE(usage,'{}'::jsonb)||jsonb_build_object('interpretation_ms',$2::int) WHERE id=$1",
          [id, elapsedMs],
        )
        if (result.stop_reason !== 'end_turn')
          throw new HttpError(502, 'Search interpretation did not complete. Please retry.')
        const text = Array.isArray(result.content)
          ? result.content
              .filter(
                (b: { type?: string; text?: unknown }) =>
                  b.type === 'text' && typeof b.text === 'string',
              )
              .map((b: { text: string }) => b.text)
              .join('')
          : ''
        let value: unknown
        try {
          value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
        } catch {
          throw new HttpError(502, 'Could not interpret this search safely. Please retry.')
        }
        const count = (key: string): number | null =>
          Number.isSafeInteger(usage?.[key]) && usage[key] >= 0 ? usage[key] : null
        const input = count('input_tokens')
        const read =
          usage?.cache_read_input_tokens === undefined ? 0 : count('cache_read_input_tokens')
        const write =
          usage?.cache_creation_input_tokens === undefined
            ? 0
            : count('cache_creation_input_tokens')
        return {
          intent: validateIntent(value),
          metrics: {
            mode: 'sonnet',
            elapsedMs,
            inputTokens:
              input !== null && read !== null && write !== null ? input + read + write : null,
            outputTokens: count('output_tokens'),
          },
        }
      }),
    signal,
  )
}
