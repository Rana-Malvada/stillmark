import type { FileProgress } from '@/lib/upload/upload-response'

export function uploadSummary(files: FileProgress[]) {
  let waiting = 0
  let transferring = 0
  let queued = 0
  let processing = 0
  let failedCount = 0
  let finished = 0
  let points = 0
  let remaining = 0
  let transferred = 0
  let failed = false
  let active = false
  let known = true
  for (const f of files) {
    if (f.phase === 'waiting') waiting++
    if (f.phase === 'uploading') transferring++
    if (f.phase === 'processing') {
      if (f.serverQueued && f.queueState !== 'processing') queued++
      else processing++
    }
    const done = f.phase === 'success' || f.phase === 'skipped'
    if (done) finished++
    points += done ? 100 : f.phase === 'failed' ? 0 : Math.min(99, f.percent)
    if (f.phase === 'failed') failedCount++
    failed ||= f.phase === 'failed'
    active ||= f.phase === 'uploading'
    transferred += f.transferredBytes ?? 0
    if (!done) {
      if (f.sizeBytes === undefined) known = false
      remaining += Math.max(0, (f.sizeBytes ?? 0) - (f.uploadedBytes ?? 0))
    }
  }
  return {
    failedCount,
    waiting,
    transferring,
    queued,
    processing,
    finished,
    percent: files.length ? Math.floor(points / files.length) : 0,
    remaining,
    transferred,
    failed,
    active,
    known,
  }
}
export const UPLOAD_ROW_HEIGHT = 40

export function uploadRowOffsets(files: FileProgress[]) {
  const offsets = [0]
  for (let index = 0; index < files.length; index++) {
    offsets.push(offsets[offsets.length - 1] + UPLOAD_ROW_HEIGHT)
  }
  return offsets
}

export function uploadWindow(
  scrollTop: number,
  count: number,
  viewportHeight = 256,
  offsets?: number[],
) {
  const at = (index: number) => offsets?.[index] ?? index * UPLOAD_ROW_HEIGHT
  const rowAt = (position: number) => {
    let lo = 0
    let hi = count
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (at(mid + 1) <= position) lo = mid + 1
      else hi = mid
    }
    return Math.min(lo, Math.max(0, count - 1))
  }
  const start = Math.max(0, rowAt(Math.max(0, scrollTop)) - 2)
  const end = Math.min(
    count,
    Math.max(start + 8, rowAt(Math.max(0, scrollTop) + viewportHeight) + 3),
  )
  return { start, end, before: at(start), after: at(count) - at(end) }
}
