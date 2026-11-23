import { uploadRequestStep } from './upload/upload-request-trace'
/** Response headers for anything that depends on who is signed in. */
export const PRIVATE_NO_STORE = { 'Cache-Control': 'private, no-store' } as const
export type HttpErrorCode = 'SESSION_REQUIRED' | 'GATEWAY_AUTH_FAILED' | 'ACCESS_DENIED'
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterSeconds?: number,
    public code?: HttpErrorCode,
  ) {
    super(message)
  }
}
/**
 * Turn any thrown value into the JSON error response. Expected errors (HttpError,
 * malformed JSON) are returned without an error-level log; anything else is logged
 * once, tagged with `context`, and reported to the client without internal detail.
 */
export function apiError(error: unknown, context = 'request'): Response {
  if (error instanceof HttpError) {
    const code = error.code ?? (error.status === 403 ? 'ACCESS_DENIED' : undefined)
    if (code) console.warn('[access-denied]', { status: error.status, code })
    return Response.json(
      { error: error.message, ...(code ? { code } : {}) },
      {
        status: error.status,
        headers: error.retryAfterSeconds
          ? { 'Retry-After': String(error.retryAfterSeconds) }
          : undefined,
      },
    )
  }
  if (error instanceof SyntaxError)
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  console.error(`[${context}]`, error)
  return Response.json({ error: 'Request failed. Please try again.' }, { status: 500 })
}
export function integer(value: unknown, name: string, min = 1, max = 2147483647): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !String(value).trim())
    throw new HttpError(400, `Invalid ${name}`)
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(400, `Invalid ${name}`)
  return n
}
export function textValue(value: unknown, name: string, max = 255): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value))
    throw new HttpError(400, `Invalid ${name}`)
  return value.trim()
}
export async function readBody(req: Request, maxBytes: number): Promise<Buffer> {
  req.signal.throwIfAborted()
  if (Number(req.headers.get('content-length')) > maxBytes)
    throw new HttpError(413, 'Request too large')
  if (!req.body) throw new HttpError(400, 'Missing request body')
  const reader = req.body.getReader()
  // A Request's signal does not necessarily cancel its body stream (for example
  // a forwarded stream). Release admission promptly when the caller goes away.
  const cancel = () => {
    void reader.cancel(req.signal.reason).catch(() => {})
  }
  req.signal.addEventListener('abort', cancel, { once: true })
  if (req.signal.aborted) cancel()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      req.signal.throwIfAborted()
      if (done) break
      size += value.length
      if (size > maxBytes) {
        // An upstream cancel hook may never settle. It must not retain our slot.
        cancel()
        throw new HttpError(413, 'Request too large')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  } finally {
    req.signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}
export async function jsonBody(
  req: Request,
  maxBytes = 64 * 1024,
): Promise<Record<string, unknown>> {
  const body = JSON.parse(
    (await uploadRequestStep('request-body', () => readBody(req, maxBytes))).toString('utf8'),
  )
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'Invalid request body')
  return body
}
