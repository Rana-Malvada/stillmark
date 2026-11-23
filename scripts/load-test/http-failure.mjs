// Retain only fixed diagnostic categories, never provider bodies or credentials.
export async function classifyHttpFailure(res) {
  const reader = res.body?.getReader()
  if (!reader) return 'http_error'
  const chunks = []
  let bytes = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.length
      if (bytes > 1024) return 'http_error'
      chunks.push(part.value)
    }
    const text = Buffer.concat(chunks).toString()
    try {
      const data = JSON.parse(text)
      if (res.status === 500 && data.error === 'Request failed. Please try again.')
        return 'application_request_failed'
      if (res.status === 503 && data.error === 'Authentication is temporarily busy. Please retry.')
        return 'authentication_busy'
    } catch {
      /* Non-JSON ingress errors are classified by fixed markers only. */
    }
    if (/upstream connect error|no healthy upstream|upstream request timeout/i.test(text))
      return 'upstream_unavailable'
    return 'http_error'
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// Explicit allowlists prevent arbitrary exception properties from leaking secrets.
const errorNames = new Set([
  'Error',
  'TypeError',
  'SyntaxError',
  'AbortError',
  'TimeoutError',
  'AggregateError',
])
const errorCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_ABORTED',
  'UND_ERR_DESTROYED',
  'UND_ERR_CLOSED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
])
export function safeTransportFailure(error) {
  const result = {}
  if (errorNames.has(error?.name)) result.name = error.name
  if (errorCodes.has(error?.code)) result.code = error.code
  if (errorCodes.has(error?.cause?.code)) result.causeCode = error.cause.code
  if (errorNames.has(error?.cause?.name)) result.causeName = error.cause.name
  return result
}
