import { withHeaderDeadline } from './request-deadline'
import { observeRequest } from './request-observability'

/** Public handlers establish their own capability scope; never supply a user identity. */
export function withPublicRequest<A extends unknown[]>(
  handler: (request: Request, ...args: A) => Promise<Response>,
) {
  return (request: Request, ...args: A): Promise<Response> => {
    if (process.env.UPLOAD_SERVICE_ONLY === 'true')
      return Promise.resolve(new Response('Not found', { status: 404 }))
    return observeRequest(request, async () => {
      const response = await withHeaderDeadline(request, (bounded) => handler(bounded, ...args))
      // This includes deadline responses, which must never be cached by intermediaries.
      response.headers.set('Cache-Control', 'private, no-store')
      response.headers.set('Referrer-Policy', 'no-referrer')
      response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
      response.headers.set('X-Content-Type-Options', 'nosniff')
      return response
    })
  }
}
