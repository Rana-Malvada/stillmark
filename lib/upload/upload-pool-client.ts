import { uploadAccessError } from './upload-access-error'

/** Coalesce startup requests from concurrently admitted browser files. */
let pending: Promise<void> | undefined
let readyUntil = 0
async function startUploadPool() {
  if (Date.now() < readyUntil) return
  if (pending) return pending
  pending = (async () => {
    const deadline = Date.now() + 20 * 60 * 1000
    let requested = false
    let failures = 0
    while (Date.now() < deadline) {
      try {
        const response = await fetch('/api/upload/routing', {
          method: requested ? 'GET' : 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          signal: AbortSignal.timeout(20000),
        })
        // A deployment/proxy can return HTML or an empty body. Preserve the
        // HTTP outcome instead of leaking Safari's JSON SyntaxError to files.
        const body = await response.text()
        let state: { code?: unknown; ready?: unknown; phase?: unknown } | undefined
        try {
          state = JSON.parse(body)
        } catch {
          // Validate below, after checking authentication and retryable status.
        }
        const accessError = uploadAccessError(response.status, state?.code, body)
        if (accessError) throw accessError
        if ([408, 425, 429, 500, 502, 503, 504].includes(response.status))
          throw new Error(`Upload service temporarily unavailable (HTTP ${response.status})`)
        if (!response.ok && response.status !== 409)
          throw Object.assign(new Error('Unable to start upload service. Please retry.'), {
            stopRetry: true,
          })
        if (!state || typeof state !== 'object' || typeof state.ready !== 'boolean')
          throw new Error('Upload service returned an invalid startup response')
        if (response.ok) requested = true
        if (state.ready) {
          readyUntil = Date.now() + 5000
          return
        }
        if (state.phase === 'error')
          throw Object.assign(new Error('Upload service could not start. Please retry.'), {
            stopRetry: true,
          })
        failures = 0
      } catch (error) {
        if ((error as { stopRetry?: boolean })?.stopRetry) throw error
        // Keep the single shared startup request pending during brief restarts,
        // rather than failing every queued file. The outer deadline bounds it.
        failures++
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2000 * 2 ** Math.min(failures, 4), 30000)),
      )
    }
    throw new Error('Upload service startup timed out. Please retry.')
  })().finally(() => {
    pending = undefined
  })
  return pending
}

/** Cancel the caller immediately without canceling startup shared by other files. */
export async function ensureUploadPoolReady(signal?: AbortSignal) {
  signal?.throwIfAborted()
  const startup = startUploadPool()
  if (!signal) return startup
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    startup.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
