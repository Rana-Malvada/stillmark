import { HttpError } from '../http'
/** Explicit rejection avoids silently truncating older clients or losing selections. */
export function requirePagedList(params: URLSearchParams) {
  if (params.get('paged') !== 'true')
    throw new HttpError(400, 'Pagination required: request paged=true and follow nextCursor')
}
