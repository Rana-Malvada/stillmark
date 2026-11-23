import { apiError, PRIVATE_NO_STORE } from '@/lib/http'

type Handler<A extends unknown[]> = (...args: A) => Response | Promise<Response>
type RouteOptions = {
  /** Label for the server log line when the failure is unexpected. */
  tag?: string
  /** Headers every error response must also carry, for example a cache policy. */
  errorHeaders?: Readonly<Record<string, string>>
}

/**
 * Give a route handler the standard error response: `route(handler)` or
 * `route({ tag, errorHeaders }, handler)`. Authorization is not done here:
 * each handler states its own checks in its first lines.
 */
export function route<A extends unknown[]>(handler: Handler<A>): (...args: A) => Promise<Response>
export function route<A extends unknown[]>(
  options: RouteOptions,
  handler: Handler<A>,
): (...args: A) => Promise<Response>
export function route<A extends unknown[]>(first: RouteOptions | Handler<A>, second?: Handler<A>) {
  const handler = typeof first === 'function' ? first : second!
  const { tag, errorHeaders = {} } = typeof first === 'function' ? {} : first
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args)
    } catch (error) {
      const response = apiError(error, tag)
      for (const [name, value] of Object.entries(errorHeaders)) response.headers.set(name, value)
      return response
    }
  }
}

/** A JSON response that depends on who is signed in, so it is never stored. */
export function privateJson(body: unknown, init: { status?: number } = {}) {
  return Response.json(body, { ...init, headers: PRIVATE_NO_STORE })
}
