import type { ExactWindow } from '../exact-search-page'
import { HttpError, integer, textValue } from '../http'
import { personIds } from '../people/people-search'

export interface SearchOptions {
  query: string
  limit: number
  semantic: boolean
  eventId: number | null
  /** Explicit person filter (`?person=<id>`), combined with any names in the query. */
  people?: string[]
  /** Internal replay never makes a paid interpretation call. */
  includeRelated?: boolean
  interpretationAllowed?: boolean
  /** Internal saved-search path hydrates only the requested page. Never parsed from a URL. */
  deferExactHydration?: boolean
  exactWindow?: ExactWindow
}
export function searchOptions(req: Request, defaultLimit = 50): SearchOptions {
  const params = new URL(req.url).searchParams
  const raw = params.get('q')?.trim() || ''
  const query = raw ? textValue(raw, 'query', 300) : ''
  const mode = params.get('mode') || 'auto'
  if (!['auto', 'semantic'].includes(mode)) throw new HttpError(400, 'Invalid search mode')
  return {
    query,
    includeRelated: params.get('related') === 'true',
    limit: integer(params.get('limit') ?? defaultLimit, 'limit', 1, 100),
    eventId: params.has('eventId') ? integer(params.get('eventId'), 'eventId') : null,
    semantic: mode === 'semantic',
    people: personIds(params.getAll('person')),
  }
}
