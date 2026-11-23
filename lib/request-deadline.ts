/** Bound time to response headers. Healthy media bodies keep streaming afterward. */
export async function withHeaderDeadline(
  request: Request,
  work: (request: Request) => Promise<Response>,
) {
  const milliseconds = Number(process.env.BROWSE_REQUEST_TIMEOUT_MS ?? 30000)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 100 || milliseconds > 120000)
    throw Error('Invalid BROWSE_REQUEST_TIMEOUT_MS')
  const budget = new AbortController()
  const signal = AbortSignal.any([request.signal, budget.signal])
  let abort!: () => void
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  const timer = setTimeout(
    () => budget.abort(new DOMException('Request deadline exceeded', 'TimeoutError')),
    milliseconds,
  )
  timer.unref?.()
  try {
    signal.throwIfAborted()
    const result = await Promise.race([work(new Request(request, { signal })), stopped])
    signal.throwIfAborted()
    return result
  } catch (error) {
    if (budget.signal.aborted)
      return Response.json({ error: 'Request timed out. Please try again.' }, { status: 504 })
    if (request.signal.aborted) return new Response(null, { status: 499 })
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
