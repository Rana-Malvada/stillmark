import { withHeaderDeadline } from './request-deadline'
import { observeRequest } from './request-observability'
import { databaseContext } from './database/database-context'

/**
 * API-only boundary for the explicitly matched browse routes. Bind signed
 * gateway identities to the actual Request, never client-supplied headers.
 * Each handler still performs its own authentication and resource authorization.
 */
export function withBrowseRequest<A extends unknown[]>(
  handler: (request: Request, ...args: A) => Promise<Response>,
) {
  return (request: Request, ...args: A): Promise<Response> => {
    // These routes must remain unavailable on the dedicated upload service.
    if (process.env.UPLOAD_SERVICE_ONLY === 'true')
      return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
    const url = new URL(request.url)
    return observeRequest(request, () =>
      withHeaderDeadline(request, (boundedRequest) =>
        databaseContext.run(
          {
            kind: 'request',
            signal: boundedRequest.signal,
            requestBinding: { method: request.method, target: url.pathname + url.search },
          },
          () => handler(boundedRequest, ...args),
        ),
      ),
    )
  }
}
