import { HttpError } from '../http'
import { automaticUploadCapacity } from './upload-resource-capacity'

export function uploadLimit(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > 10000
  )
    throw new Error(`Invalid ${name}`)
  return value
}

// Local admission protects a small replica even when the pool-wide limit increases.
// It is not work ownership: ownership and recovery remain in Postgres leases.
export function uploadCompletionLimit() {
  return process.env.UPLOAD_COMPLETIONS_PER_INSTANCE === 'auto'
    ? automaticUploadCapacity().completions
    : uploadLimit('UPLOAD_COMPLETIONS_PER_INSTANCE', 2)
}

export function uploadChunkLimit() {
  return process.env.UPLOAD_CHUNKS_PER_INSTANCE === 'auto'
    ? automaticUploadCapacity().chunks
    : uploadLimit('UPLOAD_CHUNKS_PER_INSTANCE', 8)
}

let completing = 0
let activeCompletions = 0
async function reserveCompletionCapacity<T>(fn: (activate: () => void) => Promise<T>): Promise<T> {
  const limit = uploadCompletionLimit()
  if (completing >= limit) throw new HttpError(429, 'Upload worker is busy; retry shortly', 2)
  completing++
  let active = false
  const activate = () => {
    if (!active) {
      active = true
      activeCompletions++
    }
  }
  try {
    return await fn(activate)
  } finally {
    if (active) activeCompletions--
    completing--
  }
}

export function withUploadCompletionCapacity<T>(fn: () => Promise<T>): Promise<T> {
  return reserveCompletionCapacity(async (activate) => {
    activate()
    return fn()
  })
}

/** Reserve before claiming so no leased job waits for a local slot. Empty polls
 * are not processing and must not reset the autoscaler's idle window. */
export function withUploadClaimCapacity<T>(
  claim: () => Promise<T | undefined>,
  processJob: (job: T) => Promise<void>,
): Promise<void> {
  return reserveCompletionCapacity(async (activate) => {
    const job = await claim()
    if (job === undefined) return
    activate()
    await processJob(job)
  })
}

let receivingChunks = 0
export function uploadActiveOperations() {
  return activeCompletions + receivingChunks
}
type ChunkWaiter = { grant: () => void }
const chunkWaiters: ChunkWaiter[] = []

async function reserveChunk(signal?: AbortSignal, waitMs = 0): Promise<void> {
  signal?.throwIfAborted()
  if (receivingChunks < uploadChunkLimit() && !chunkWaiters.length) {
    receivingChunks++
    return
  }
  // Waiting requests have not read their bodies. Bound both count and time so
  // overload still produces backpressure rather than an unbounded memory queue.
  const maxWaiting = Math.min(1024, uploadChunkLimit() * 16)
  if (waitMs <= 0 || chunkWaiters.length >= maxWaiting)
    throw new HttpError(429, 'Upload worker is receiving files; retry shortly', 2)
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      const index = chunkWaiters.indexOf(waiter)
      if (index >= 0) chunkWaiters.splice(index, 1)
    }
    const abort = () => {
      cleanup()
      reject(signal?.reason ?? new Error('Upload cancelled'))
    }
    const waiter = {
      grant: () => {
        cleanup()
        receivingChunks++
        resolve()
      },
    }
    const timer = setTimeout(
      () => {
        cleanup()
        reject(new HttpError(429, 'Upload worker is receiving files; retry shortly', 2))
      },
      Math.min(waitMs, 10000),
    )
    chunkWaiters.push(waiter)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
export async function withUploadChunkCapacity<T>(
  fn: () => Promise<T>,
  options: { signal?: AbortSignal; waitMs?: number } = {},
): Promise<T> {
  await reserveChunk(options.signal, options.waitMs)
  try {
    options.signal?.throwIfAborted()
    return await fn()
  } finally {
    receivingChunks--
    // Reserve the slot before waking the waiter; new arrivals cannot overtake it.
    while (chunkWaiters.length && receivingChunks < uploadChunkLimit()) chunkWaiters[0].grant()
  }
}
