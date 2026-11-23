/** Closed vocabularies: diagnostic fields never contain request/customer data. */
export const phases = new Set([
  'auth',
  'auth-bootstrap-query',
  'db-checkout',
  'db-query',
  'db-read-batch',
  'db-transaction-commit',
  'db-transaction-rollback',
  'db-transaction-start',
  'media-auth',
  'media-fetch-headers',
  'media-lookup',
  'media-presign',
  'request-body',
  'response-body',
  'snowflake-query',
  'storage-execute',
  'storage-warehouse-check',
])
export const routes = new Set(['media', 'albums', 'photos', 'search', 'people', 'travels', 'other'])
export const metrics = new Set([
  'database-pool',
  'activity-work',
  'activity-dropped',
  'maintenance-pool',
  'gateway-roles',
  'gateway-user-refresh',
  ...[...phases].map((p) => `phase:${p}`),
  ...[...routes].map((r) => `headers:${r}`),
  ...[...routes].map((r) => `body:${r}`),
])
export const durationBounds = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
] as const
const networkCodes = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNABORTED',
  'ABORT_ERR',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ERR_SOCKET_CLOSED',
])
export function diagnosticCode(error: unknown): string | undefined {
  const seen = new Set<unknown>()
  for (
    let depth = 0;
    depth < 4 && error && typeof error === 'object' && !seen.has(error);
    depth++
  ) {
    seen.add(error)
    const e = error as { code?: unknown; name?: unknown; cause?: unknown }
    if (typeof e.code === 'string' && (networkCodes.has(e.code) || /^[0-9A-Z]{5}$/.test(e.code)))
      return e.code
    if (e.name === 'TimeoutError') return 'TIMEOUT'
    if (e.name === 'AbortError') return 'ABORT_ERR'
    error = e.cause
  }
}

/** Background uploads use a separate closed phase vocabulary from HTTP traces. */
export const uploadProcessingPhases = [
  'authorize',
  'renew-session',
  'read-thumbnail',
  'complete',
  'acknowledge',
] as const
export type UploadProcessingPhase = (typeof uploadProcessingPhases)[number]
export function uploadFailureDiagnostic(
  error: unknown,
  job: {
    uploadId: string
    attempt: number
    phase: UploadProcessingPhase
    retry: boolean
  },
) {
  return {
    event: 'upload-processing-failed',
    uploadId: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(job.uploadId)
      ? job.uploadId
      : undefined,
    attempt: Number.isSafeInteger(job.attempt) && job.attempt >= 0 ? job.attempt : undefined,
    phase: uploadProcessingPhases.includes(job.phase) ? job.phase : undefined,
    code: diagnosticCode(error) ?? 'OTHER',
    retry: job.retry === true,
  }
}
