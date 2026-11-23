/** Shared queue state and wire contracts; components only render validated state. */
export interface FileProgress {
  serverQueued?: boolean
  queueState?: 'queued' | 'processing'
  sizeBytes?: number
  uploadedBytes?: number
  transferredBytes?: number
  filename: string
  percent: number
  phase: 'waiting' | 'uploading' | 'processing' | 'success' | 'skipped' | 'failed'
  photoId?: number
  skipReason?: 'metadata'
  existingFilename?: string
  error?: string
}
export type UploadResult = {
  eventId: number
  results: {
    status: 'success' | 'skipped'
    photoId: number
    filename?: string
    existingFilename?: string
  }[]
  queued?: false
}
export type UploadCompletion = UploadResult | { queued: true; uploadId: string }
export type UploadJob = {
  uploadId: string
  state: 'queued' | 'processing' | 'done' | 'failed'
  result?: UploadResult | null
  error?: string | null
}
export type UploadJobs = { jobs: UploadJob[] }
export type UploadResume = {
  exists: boolean
  chunks: number[]
  totalChunks?: number
  chunkHashes?: Record<string, string>
  activeChunks?: number[]
  metadata?: Record<string, unknown> | null
  result?: UploadResult | null
  queued?: boolean
}
export type UploadChunk = { ok: true; chunkIndex?: number; completed?: boolean }
export type UploadResponse = UploadCompletion | UploadJobs | UploadResume | UploadChunk
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const index = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const optionalString = (value: unknown) => value === undefined || typeof value === 'string'
export function isUploadResult(value: unknown): value is UploadResult {
  return (
    record(value) &&
    id(value.eventId) &&
    Array.isArray(value.results) &&
    value.results.length === 1 &&
    value.results.every(
      (result) =>
        record(result) &&
        typeof result.status === 'string' &&
        ['success', 'skipped'].includes(result.status) &&
        id(result.photoId) &&
        optionalString(result.filename) &&
        optionalString(result.existingFilename),
    )
  )
}
export function isUploadCompletion(value: unknown): value is UploadCompletion {
  return (
    record(value) &&
    (value.queued === true
      ? uuid(value.uploadId) && value.results === undefined
      : (value.queued === undefined || value.queued === false) && isUploadResult(value))
  )
}
export function isUploadJobs(value: unknown): value is UploadJobs {
  if (!record(value) || !Array.isArray(value.jobs) || value.jobs.length > 100) return false
  const ids = new Set<string>()
  return value.jobs.every((job) => {
    if (
      !record(job) ||
      !uuid(job.uploadId) ||
      ids.has(job.uploadId) ||
      typeof job.state !== 'string' ||
      !['queued', 'processing', 'done', 'failed'].includes(job.state) ||
      (job.error != null && typeof job.error !== 'string') ||
      (job.result != null && !isUploadResult(job.result)) ||
      (job.state === 'done' && !isUploadResult(job.result))
    )
      return false
    ids.add(job.uploadId)
    return true
  })
}
export function isUploadResume(value: unknown): value is UploadResume {
  if (
    !record(value) ||
    typeof value.exists !== 'boolean' ||
    !Array.isArray(value.chunks) ||
    !value.chunks.every(index) ||
    new Set(value.chunks).size !== value.chunks.length ||
    (value.result != null && !isUploadResult(value.result)) ||
    (value.queued !== undefined && typeof value.queued !== 'boolean') ||
    (value.metadata != null && !record(value.metadata))
  )
    return false
  if (value.totalChunks !== undefined && !id(value.totalChunks)) return false
  if (value.exists && !id(value.totalChunks)) return false
  if (!value.exists && (value.chunks.length || value.result || value.queued)) return false
  if (
    value.activeChunks !== undefined &&
    (!Array.isArray(value.activeChunks) || !value.activeChunks.every(index))
  )
    return false
  if (
    value.chunkHashes !== undefined &&
    (!record(value.chunkHashes) ||
      !Object.entries(value.chunkHashes).every(
        ([key, hash]) =>
          /^(0|[1-9][0-9]*)$/.test(key) &&
          Number.isSafeInteger(Number(key)) &&
          typeof hash === 'string' &&
          /^[0-9a-f]{64}$/i.test(hash),
      ))
  )
    return false
  if (
    value.exists &&
    [
      ...value.chunks,
      ...((value.activeChunks ?? []) as number[]),
      ...Object.keys(value.chunkHashes ?? {}).map(Number),
    ].some((chunk) => chunk >= Number(value.totalChunks))
  )
    return false
  return true
}
export function isUploadResponse(
  url: string,
  method: string | undefined,
  value: unknown,
): value is UploadResponse {
  if (url === '/api/upload/status') return isUploadJobs(value)
  if (url === '/api/upload/complete') return isUploadCompletion(value)
  if (method === 'GET') return isUploadResume(value)
  return (
    record(value) &&
    value.ok === true &&
    (value.chunkIndex === undefined || index(value.chunkIndex)) &&
    (value.completed === undefined || typeof value.completed === 'boolean')
  )
}
