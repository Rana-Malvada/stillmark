/** One bounded recovery for a transport failure before read-only browse headers arrive.
 * HTTP errors and explicit cancellation are never retried; writes are rejected. */
export async function fetchBrowse(input: string, init: RequestInit = {}): Promise<Response> {
  if (
    !/^\/api\/(?:events(?:\/\d+)?|favorites|photos\/\d+)(?:\?|$)/.test(input) ||
    (init.method !== undefined && init.method.toUpperCase() !== 'GET') ||
    init.body != null
  )
    throw new Error('Browse recovery supports read-only album and photo requests')
  try {
    return await fetch(input, init)
  } catch (error) {
    if (!(error instanceof TypeError) || init.signal?.aborted) throw error
    await new Promise<void>((resolve, reject) => {
      const signal = init.signal
      const abort = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }, 150)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException('Aborted', 'AbortError')
    return fetch(input, init)
  }
}
