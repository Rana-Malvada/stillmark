import { databaseContext } from '../database/database-context'
import { apiError } from '../http'
import { searchTimedOut, searchTimeoutMs } from './search-admission'

/** Each subscriber has its own total budget, including auth, admission and hydration. */
export function withSearchRequest(handler: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    if (request.signal.aborted) return new Response(null, { status: 499 })
    const timeoutMs = searchTimeoutMs()
    const budget = new AbortController()
    const signal = AbortSignal.any([request.signal, budget.signal])
    let abort!: () => void
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    const timer = setTimeout(() => budget.abort(searchTimedOut()), timeoutMs)
    timer.unref?.()
    try {
      signal.throwIfAborted()
      const response = await Promise.race([
        Promise.resolve().then(() => {
          signal.throwIfAborted()
          return databaseContext.run({ kind: 'request', signal }, () =>
            handler(new Request(request, { signal })),
          )
        }),
        stopped,
      ])
      signal.throwIfAborted()
      return response
    } catch (error) {
      if (request.signal.aborted) return new Response(null, { status: 499 })
      return apiError(error)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
}
