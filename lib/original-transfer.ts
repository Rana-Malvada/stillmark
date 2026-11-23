/** Bound original-file preparation without recompressing or changing its bytes.
 * Ten minutes accommodates large videos; an idle body still fails in 45 seconds.
 * Cancellation closes the transport, and a new user gesture owns every retry. */
export async function loadOriginal(
  url: string,
  signal: AbortSignal,
  { timeoutMs = 600_000, idleMs = 45_000 } = {},
): Promise<Blob> {
  const controller = new AbortController()
  const combined = AbortSignal.any([signal, controller.signal])
  let idle: ReturnType<typeof setTimeout> | undefined
  let total: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const timeoutError = new Error(
    'Preparing the original timed out. Please try again or download the file.',
  )
  const bounded = new Promise<never>((_, reject) => {
    abort = () => reject(combined.reason)
    combined.addEventListener('abort', abort, { once: true })
    total = setTimeout(() => controller.abort(timeoutError), timeoutMs)
  })
  const progress = () => {
    clearTimeout(idle)
    idle = setTimeout(() => controller.abort(timeoutError), idleMs)
  }
  try {
    combined.throwIfAborted()
    progress()
    return await Promise.race([
      bounded,
      (async () => {
        const response = await fetch(url, { signal: combined, redirect: 'error' })
        if (!response.ok) throw new Error('Unable to load the original. Please try again.')
        const reader = response.body?.getReader()
        if (!reader) throw new Error('The original file is unavailable. Please try again.')
        const parts: Uint8Array<ArrayBuffer>[] = []
        try {
          while (true) {
            const { done, value } = await reader.read()
            combined.throwIfAborted()
            if (done) break
            if (value.length) {
              parts.push(value)
              progress()
            }
          }
          return new Blob(parts, { type: response.headers.get('Content-Type') ?? '' })
        } finally {
          void reader.cancel().catch(() => {})
        }
      })(),
    ])
  } finally {
    clearTimeout(idle)
    clearTimeout(total)
    if (abort) combined.removeEventListener('abort', abort)
    controller.abort()
  }
}
