import { uploadTraceCount } from '../upload/upload-request-trace'

const transientCodes = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'])
function networkCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return
  const value = error as { code?: unknown; cause?: { code?: unknown } }
  const code = value.cause?.code ?? value.code
  return typeof code === 'string' && transientCodes.has(code) ? code : undefined
}
/** Bound time to headers, not the lifetime of a healthy streaming response. */
export async function fetchMedia(
  url: string,
  headers: HeadersInit | undefined,
  signal: AbortSignal,
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Media response timed out')), 30000)
  const combined = AbortSignal.any([signal, controller.signal])
  try {
    for (let attempt = 0; ; attempt++) {
      combined.throwIfAborted()
      try {
        return await fetch(url, { headers, signal: combined, cache: 'no-store' })
      } catch (error) {
        const code = networkCode(error)
        if (code) uploadTraceCount('media-network-' + code)
        else uploadTraceCount(combined.aborted ? 'media-fetch-aborted' : 'media-fetch-other-error')
        // Only an idempotent GET before headers. Never retry cancellation, HTTP
        // denials, or a response body that has already started streaming.
        if (attempt || combined.aborted || !code) throw error
        uploadTraceCount('media-network-retry')
      }
    }
  } finally {
    clearTimeout(timer)
  }
}
