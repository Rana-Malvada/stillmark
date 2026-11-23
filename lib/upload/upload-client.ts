import {
  isUploadResponse,
  type UploadCompletion,
  type UploadJobs,
  type UploadResponse,
  type UploadResume,
} from './upload-response'
import { ensureUploadPoolReady } from './upload-pool-client'
import { uploadAccessError } from './upload-access-error'
import { generateVideoThumbnail } from '@/lib/video/video-thumbnail'
import { CHUNK_BYTES, MAX_FILE_BYTES, MAX_IMAGE_BYTES } from '@/lib/upload/upload-limits'

export interface UploadProgress {
  uploadedBytes?: number
  transferredBytes?: number
  sizeBytes?: number
  percent: number
  phase: 'uploading' | 'processing'
}

function waitForRetry(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted()
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

// Fetch does not expose upload byte progress; XHR does, including within a chunk.
function sendChunk(
  url: string,
  body: FormData,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.timeout = 120_000
    let stalled: ReturnType<typeof setTimeout> | undefined
    let loaded = 0
    const clearStall = () => clearTimeout(stalled)
    const cleanup = () => {
      clearStall()
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      reject(signal?.reason)
      xhr.abort()
    }
    signal?.addEventListener('abort', abort, { once: true })
    const armStall = () => {
      clearStall()
      stalled = setTimeout(() => {
        cleanup()
        reject(new Error('Upload stopped making progress; retrying this chunk'))
        xhr.abort()
      }, 30_000)
    }
    xhr.upload.onprogress = (event) => {
      if (event.loaded > loaded) {
        loaded = event.loaded
        armStall()
      }
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total)
        // Once sent, allow the server's existing two-minute response deadline.
        if (event.loaded >= event.total) clearStall()
      }
    }
    xhr.onload = () => {
      cleanup()
      // A browser/network failure can report status 0; Response rejects that status.
      if (xhr.status < 200) return reject(new Error('Upload connection interrupted'))
      const retryAfter = xhr.getResponseHeader?.('Retry-After')
      resolve(
        new Response(xhr.responseText, {
          status: xhr.status,
          headers: retryAfter ? { 'Retry-After': retryAfter } : undefined,
        }),
      )
    }
    const fail = (message: string) => {
      cleanup()
      reject(new Error(message))
    }
    xhr.onerror = () => fail('Upload connection interrupted')
    xhr.ontimeout = () => fail('Upload timed out')
    xhr.onabort = () => fail('Upload interrupted')
    armStall()
    try {
      xhr.send(body)
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

/** One budget covers transfers, response bodies and retry waits for this operation.
 * Exceeding it leaves the stable upload ID/chunks resumable; it never deletes a
 * possibly committed upload. Durable processing continues independently. */
async function request<T extends UploadResponse>(
  url: string,
  init: RequestInit,
  attempts = 4,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  const budget = new AbortController()
  const timeout = setTimeout(
    () =>
      budget.abort(
        new Error('Upload recovery timed out; resume this upload to check its saved status.'),
      ),
    300_000,
  )
  try {
    return await requestAttempts<T>(
      url,
      init,
      attempts,
      onProgress,
      signal ? AbortSignal.any([signal, budget.signal]) : budget.signal,
    )
  } finally {
    clearTimeout(timeout)
  }
}

async function requestAttempts<T extends UploadResponse>(
  url: string,
  init: RequestInit,
  attempts = 4,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  let last: Error = new Error('Upload failed')
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted()
    let delay = Math.min(1000 * 2 ** attempt, 8000)
    const controller = new AbortController()
    const timeout = onProgress ? undefined : setTimeout(() => controller.abort(), 30_000)
    try {
      onProgress?.(0)
      const response = onProgress
        ? await sendChunk(url, init.body as FormData, onProgress, signal)
        : await fetch(url, {
            ...init,
            credentials: 'same-origin',
            signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          })
      // Ingress and gateway failures can be HTML/plain text, including expired
      // sessions. Do not let a JSON parser replace their HTTP status with a
      // browser-specific syntax error, or display an upstream HTML response.
      const body = await response.text()
      signal?.throwIfAborted()
      let data: unknown
      try {
        data = JSON.parse(body)
      } catch {
        /* Handled by HTTP status below. */
      }
      if (response.ok) {
        if (isUploadResponse(url, init.method, data)) {
          if (
            'queued' in data &&
            data.queued &&
            'uploadId' in data &&
            typeof init.body === 'string' &&
            data.uploadId !== JSON.parse(init.body).uploadId
          )
            throw new Error('Invalid upload response ID')
          if (
            'chunkIndex' in data &&
            data.chunkIndex !== undefined &&
            init.body instanceof FormData &&
            data.chunkIndex !== Number(init.body.get('chunkIndex'))
          )
            throw new Error('Invalid upload chunk response')
          return data as T
        }
        throw new Error('Upload server returned an invalid response. Please retry.')
      }
      const failure =
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : {}
      const accessError = uploadAccessError(response.status, failure.code, body)
      if (accessError) {
        console.warn('[upload-access]', {
          status: response.status,
          code: accessError.code,
          stage: url.startsWith('/api/upload/chunk')
            ? init.method === 'GET'
              ? 'resume-check'
              : 'chunk'
            : 'completion',
        })
        throw accessError
      }
      if (
        response.status === 429 &&
        url === '/api/upload/chunk' &&
        init.method === 'POST' &&
        init.body instanceof FormData &&
        failure.error === 'Chunk is already uploading; retry shortly'
      ) {
        // A previous timed-out request may still be committing this exact chunk.
        // Observe its durable result instead of retransmitting bytes four times.
        const form = init.body
        const id = String(form.get('uploadId'))
        const index = Number(form.get('chunkIndex'))
        const chunk = form.get('chunk')
        if (!(chunk instanceof Blob))
          throw Object.assign(new Error('Invalid upload chunk'), { stopRetry: true })
        const digest = await crypto.subtle.digest('SHA-256', await chunk.arrayBuffer())
        const hash = Array.from(new Uint8Array(digest), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join('')
        let polls = 0
        while (true) {
          await waitForRetry(Math.min(2500 * 2 ** Math.min(polls++, 2), 10000), signal)
          const saved = await requestAttempts<UploadResume>(
            `/api/upload/chunk?uploadId=${encodeURIComponent(id)}`,
            { method: 'GET' },
            2,
            undefined,
            signal,
          )
          if (saved.chunkHashes?.[index]) {
            if (saved.chunkHashes[index] !== hash)
              throw Object.assign(
                new Error('Saved chunk differs from this file. Reselect the original file.'),
                { stopRetry: true },
              )
            return { ok: true, chunkIndex: index } as T
          }
          if (saved.exists === false)
            throw Object.assign(
              new Error('Upload expired; resume this file to start a new upload.'),
              { stopRetry: true },
            )
          if (!Array.isArray(saved.activeChunks) || !saved.activeChunks.includes(index)) break
        }
        // Busy responses do not consume the transport-error retry allowance.
        // The outer five-minute budget still bounds all polling and retries.
        attempt--
        continue
      }
      if (response.status === 429) {
        const header = response.headers.get('Retry-After')
        const seconds = header ? Number(header) : NaN
        const milliseconds = Number.isFinite(seconds)
          ? seconds * 1000
          : header
            ? Date.parse(header) - Date.now()
            : NaN
        delay = Math.min(
          300_001,
          Math.max(
            1000,
            Number.isFinite(milliseconds)
              ? milliseconds + 500
              : url === '/api/upload/complete'
                ? 1500
                : 60_500,
          ),
        )
      }
      last = new Error(
        typeof failure.error === 'string'
          ? failure.error
          : `Upload request failed (HTTP ${response.status}). Please retry.`,
      )
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status))
        throw Object.assign(last, { permanent: true })
    } catch (error) {
      signal?.throwIfAborted()
      if (
        (error as { permanent?: boolean; stopRetry?: boolean }).permanent ||
        (error as { stopRetry?: boolean }).stopRetry
      )
        throw error
      last = controller.signal.aborted
        ? new Error('Upload request timed out; retry this file')
        : error instanceof Error
          ? error
          : last
    } finally {
      clearTimeout(timeout)
    }
    if (url === '/api/upload/complete' && typeof init.body === 'string') {
      const { uploadId } = JSON.parse(init.body)
      if (typeof uploadId === 'string') {
        const saved = await reconcileUploadCompletion(uploadId, signal)
        if (saved) return saved as T
      }
    }
    if (attempt < attempts - 1) await waitForRetry(delay, signal)
  }
  throw last
}

/** A lost completion acknowledgement must not strand an accepted durable job in
 * a transfer slot. This read uses the owner-authorized status endpoint, without
 * resending bytes or treating a missing/failed status response as success. */
async function reconcileUploadCompletion(uploadId: string, signal?: AbortSignal) {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), 10_000)
  try {
    const data = await requestAttempts<UploadJobs>(
      '/api/upload/status',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadIds: [uploadId] }),
      },
      1,
      undefined,
      signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
    )
    const job = data.jobs.find((item) => item.uploadId === uploadId)
    if (job?.state === 'done' && job.result) return job.result
    if (job?.state === 'queued' || job?.state === 'processing')
      return { queued: true as const, uploadId }
    if (job?.state === 'failed')
      throw Object.assign(new Error(job.error || 'Upload processing failed; retry this file'), {
        stopRetry: true,
      })
  } catch (error) {
    signal?.throwIfAborted()
    if ((error as { stopRetry?: boolean }).stopRetry) throw error
    // A status outage does not authorize abandoning or duplicating the upload.
    // Continue the original idempotent completion retry within its total budget.
  } finally {
    clearTimeout(timer)
  }
}

/** Stable ID and immutable chunks make network retries safe, including completion. */
export async function uploadFile(
  file: File,
  fields: Record<string, unknown>,
  onProgress?: (progress: UploadProgress) => void,
  resumeId?: string,
  signal?: AbortSignal,
): Promise<UploadCompletion> {
  signal?.throwIfAborted()
  await ensureUploadPoolReady(signal)
  signal?.throwIfAborted()
  let transferredBytes = 0
  onProgress?.({
    percent: 0,
    phase: 'uploading',
    sizeBytes: file.size,
    uploadedBytes: 0,
    transferredBytes,
  })
  const video = /\.(mov|mp4|m4v)$/i.test(file.name)
  if (!file.size || file.size > (video ? MAX_FILE_BYTES : MAX_IMAGE_BYTES))
    throw new Error('Upload limit: 64 MiB per image, 4 GiB per video')
  const uploadId = resumeId ?? crypto.randomUUID()
  const totalChunks = Math.ceil(file.size / CHUNK_BYTES)
  try {
    const saved: UploadResume = resumeId
      ? await request<UploadResume>(
          `/api/upload/chunk?uploadId=${uploadId}`,
          { method: 'GET' },
          4,
          undefined,
          signal,
        )
      : { exists: false, chunks: [] }
    if (saved.result) return saved.result
    if (saved.queued) return { queued: true, uploadId }
    if (saved.exists && saved.totalChunks !== totalChunks)
      throw new Error('Saved upload does not match this file')
    const received = new Set<number>(saved.chunks)
    // Verify retained chunks against the reselected original before combining bytes.
    for (const index of received) {
      const expected = saved.chunkHashes?.[index]
      if (!expected) {
        received.delete(index)
        continue
      } // Older server: resend for its immutable-chunk check.
      const digest = await crypto.subtle.digest(
        'SHA-256',
        await file.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).arrayBuffer(),
      )
      const actual = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('')
      if (actual !== expected)
        throw Object.assign(
          new Error('This file differs from the original upload. Reselect the original file.'),
          { stopRetry: true },
        )
    }
    // Completion metadata is immutable after the first attempt; use the server copy on resume.
    const completionFields = saved.metadata ?? fields
    for (let i = 0; i < totalChunks; i++) {
      signal?.throwIfAborted()
      if (received.has(i)) {
        onProgress?.({
          uploadedBytes: Math.min(file.size, (i + 1) * CHUNK_BYTES),
          transferredBytes,
          percent: Math.min(99, (Math.min(file.size, (i + 1) * CHUNK_BYTES) / file.size) * 100),
          phase: 'uploading',
        })
        continue
      }

      const form = new FormData()
      form.set('uploadId', uploadId)
      form.set('totalChunks', String(totalChunks))
      form.set('chunkIndex', String(i))
      form.set('chunk', file.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES), file.name)
      const start = i * CHUNK_BYTES
      const size = Math.min(CHUNK_BYTES, file.size - start)
      let previousFraction = 0
      await request(
        '/api/upload/chunk',
        { method: 'POST', body: form },
        4,
        onProgress
          ? (fraction) => {
              transferredBytes += Math.max(0, fraction - previousFraction) * size
              previousFraction = fraction
              onProgress({
                uploadedBytes: start + size * fraction,
                transferredBytes,
                percent: Math.min(99, ((start + size * fraction) / file.size) * 100),
                phase: 'uploading',
              })
            }
          : undefined,
        signal,
      )
      transferredBytes += Math.max(0, 1 - previousFraction) * size
      onProgress?.({
        uploadedBytes: start + size,
        transferredBytes,
        percent: Math.min(99, ((start + size) / file.size) * 100),
        phase: 'uploading',
      })
    }
    onProgress?.({ percent: 99, phase: 'processing', uploadedBytes: file.size, transferredBytes })
    let thumbnail: string | undefined
    if (video) {
      const image = await generateVideoThumbnail(file, signal).catch(() => null)
      signal?.throwIfAborted()
      if (image) {
        const bytes = new Uint8Array(await image.arrayBuffer())
        let binary = ''
        for (let start = 0; start < bytes.length; start += 8192)
          binary += String.fromCharCode(...bytes.subarray(start, start + 8192))
        thumbnail = btoa(binary)
      }
    }
    return await request<UploadCompletion>(
      '/api/upload/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...completionFields,
          queuedProcessing: true,
          uploadId,
          totalChunks,
          fileName: file.name,
          thumbnail,
        }),
      },
      90,
      undefined,
      signal,
    )
  } catch (error) {
    // Keep transient failures resumable. Invalid files must not occupy the limited
    // unfinished-session slots and block every later file in the batch.
    if ((error as { permanent?: boolean }).permanent) {
      await fetch(`/api/upload/chunk?uploadId=${uploadId}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(10000),
      }).catch(() => {})
    }
    throw error
  }
}

/** One bounded request per group of jobs, not a long-lived completion request. */
export async function checkUploadJobs(uploadIds: string[], signal?: AbortSignal) {
  const data = await request<UploadJobs>(
    '/api/upload/status',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadIds }),
    },
    2,
    undefined,
    signal,
  )
  if (data.jobs.some((job) => !uploadIds.includes(job.uploadId)))
    throw new Error('Invalid upload status IDs')
  return data
}
export async function retryQueuedUpload(uploadId: string, signal?: AbortSignal) {
  await ensureUploadPoolReady(signal)
  return request<UploadCompletion>(
    '/api/upload/complete',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, retryOnly: true, queuedProcessing: true }),
    },
    4,
    undefined,
    signal,
  )
}
