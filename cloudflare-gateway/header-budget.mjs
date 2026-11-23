/**
 * Shared retry budget for response headers only. Never cuts off a healthy body stream.
 * @param {Fetch} fetcher
 * @param {AbortSignal} signal
 * @param {number} [milliseconds]
 * @returns {Fetch}
 */
export function headerBudget(fetcher, signal, milliseconds = 20000) {
  const deadline = performance.now() + milliseconds
  let exhausted = false
  return async (url, init) => {
    const remaining = deadline - performance.now()
    if (exhausted || remaining <= 0) throw new Error('Media upstream header deadline exceeded')
    const controller = new AbortController()
    const timer = setTimeout(() => {
      // Timers may round a fractional delay down. Once fired, retries stay stopped.
      exhausted = true
      controller.abort(new Error('Media upstream header deadline exceeded'))
    }, remaining)
    try {
      return await fetcher(url, { ...init, signal: AbortSignal.any([signal, controller.signal]) })
    } finally {
      clearTimeout(timer)
    }
  }
}
