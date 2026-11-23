// Request-owned, bounded binary frames. No cached authority or storage URLs on the wire.
export const PREVIEW_BATCH_LIMIT = 8
export const PREVIEW_BYTE_LIMIT = 512 * 1024
export const PREVIEW_CONTENT_TYPE = 'application/x-stillmark-previews'
export function previewPath(path) {
  return (
    typeof path === 'string' &&
    path.length <= 384 &&
    /^thumbnails\/[a-zA-Z0-9_./-]+\.(jpg|jpeg|png|webp)$/.test(path) &&
    !path.split('/').some((part) => !part || part === '.' || part === '..')
  )
}
/**
 * @typedef {{type: 'item-start' | 'item-headers' | 'item-body' | 'item-frame' | 'complete', index: number, status: number, bytes: number, elapsedMs: number, headerMs?: number, bodyMs?: number}} PreviewBatchEvent
 * Numeric diagnostics only. Header time ends when fetch resolves; body time includes
 * validation and reader cancellation. Body bytes count reads, frame bytes count the wire.
 * Complete uses index -1 and status 200, 499 (cancelled), or 502 (stream failure).
 */
/** @param {(string | null)[]} items
 * @param {(item: string | null, signal: AbortSignal) => Promise<Response | null>} fetchItem
 * @param {AbortSignal | undefined} signal
 * @param {((event: PreviewBatchEvent) => void | Promise<void>) | undefined} [observer]
 */
export function previewBatchStream(items, fetchItem, signal, observer) {
  if (!items.length || items.length > PREVIEW_BATCH_LIMIT) throw Error('Invalid preview batch')
  const started = observer ? Date.now() : 0
  /** @type {((event: PreviewBatchEvent) => void) | undefined} */
  const observe = observer
    ? (event) => {
        try {
          const pending = observer(event)
          if (pending) void Promise.resolve(pending).catch(() => {})
        } catch {
          // Diagnostics must never change frame delivery or cleanup.
        }
      }
    : undefined
  let frameBytes = 0
  let cancelled = false
  const abort = new AbortController()
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
  let index = 0
  return new ReadableStream({
    async start(controller) {
      // Each item is bounded; at most eight frames can be queued per request.
      async function worker() {
        while (index < items.length && !combined.aborted) {
          const i = index++
          let bytes = new Uint8Array()
          let type = ''
          let status = 404
          const itemStarted = observe ? Date.now() : 0
          let headersAt = null
          let headerMs = 0
          let receivedBytes = 0
          if (observe)
            observe({
              type: 'item-start',
              index: i,
              status: 0,
              bytes: 0,
              elapsedMs: Math.max(0, itemStarted - started),
            })
          try {
            const response = await fetchItem(items[i], combined)
            if (observe) {
              headersAt = Date.now()
              headerMs = Math.max(0, headersAt - itemStarted)
              observe({
                type: 'item-headers',
                index: i,
                status: response?.status ?? 0,
                bytes: 0,
                elapsedMs: Math.max(0, headersAt - started),
                headerMs,
              })
            }
            if (response?.status === 304) {
              status = 304
            } else if (response) {
              type = response.headers.get('content-type')?.split(';')[0] || ''
              if (
                !response.ok ||
                !['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'].includes(
                  type,
                ) ||
                Number(response.headers.get('content-length')) > PREVIEW_BYTE_LIMIT
              ) {
                await response.body?.cancel()
                throw Error('Preview unavailable')
              }
              if (!response.body) throw Error('Missing preview')
              const reader = response.body.getReader()
              const chunks = []
              let size = 0
              try {
                for (;;) {
                  const { value, done } = await reader.read()
                  if (done) break
                  size += value.length
                  if (observe) receivedBytes = size
                  if (size > PREVIEW_BYTE_LIMIT) throw Error('Preview too large')
                  chunks.push(value)
                }
              } finally {
                await reader.cancel().catch(() => {})
                reader.releaseLock()
              }
              if (!size) throw Error('Empty preview')
              bytes = new Uint8Array(size)
              let offset = 0
              for (const chunk of chunks) {
                bytes.set(chunk, offset)
                offset += chunk.length
              }
              // Internal-stage objects are served as octet-stream. Only infer
              // a preview MIME from bounded bytes matching the expected file type.
              if (type === 'application/octet-stream') {
                const path = items[i] || ''
                if (
                  /\.jpe?g$/i.test(path) &&
                  bytes[0] === 255 &&
                  bytes[1] === 216 &&
                  bytes[2] === 255
                )
                  type = 'image/jpeg'
                else if (
                  /\.png$/i.test(path) &&
                  [137, 80, 78, 71, 13, 10, 26, 10].every((v, j) => bytes[j] === v)
                )
                  type = 'image/png'
                else if (
                  /\.webp$/i.test(path) &&
                  new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
                  new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
                )
                  type = 'image/webp'
                else throw Error('Invalid preview bytes')
              }
              status = 200
            }
          } catch {
            status = 502
            bytes = new Uint8Array()
            type = ''
          }
          if (observe) {
            const finished = Date.now()
            observe({
              type: 'item-body',
              index: i,
              status: combined.aborted || cancelled ? 499 : status,
              bytes: receivedBytes,
              elapsedMs: Math.max(0, finished - started),
              headerMs: headersAt === null ? Math.max(0, finished - itemStarted) : headerMs,
              bodyMs: headersAt === null ? 0 : Math.max(0, finished - headersAt),
            })
          }
          if (combined.aborted || cancelled) return
          const header = new TextEncoder().encode(
            JSON.stringify({ index: i, status, type, length: bytes.length }),
          )
          const frame = new Uint8Array(4 + header.length + bytes.length)
          new DataView(frame.buffer).setUint32(0, header.length)
          frame.set(header, 4)
          frame.set(bytes, 4 + header.length)
          controller.enqueue(frame)
          if (observe) {
            frameBytes += frame.length
            observe({
              type: 'item-frame',
              index: i,
              status,
              bytes: frame.length,
              elapsedMs: Math.max(0, Date.now() - started),
            })
          }
        }
      }
      let completionStatus = 200
      try {
        await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker))
        if (!combined.aborted) controller.close()
        else {
          completionStatus = 499
          if (!cancelled) controller.error(Error('Preview batch cancelled'))
        }
      } catch (error) {
        completionStatus = cancelled || signal?.aborted ? 499 : 502
        abort.abort()
        if (!cancelled) controller.error(error)
      } finally {
        if (observe)
          observe({
            type: 'complete',
            index: -1,
            status: completionStatus,
            bytes: frameBytes,
            elapsedMs: Math.max(0, Date.now() - started),
          })
      }
    },
    cancel() {
      cancelled = true
      abort.abort()
    },
  })
}

/** @param {Response} response
 * @param {number} count
 * @param {(index: number, blob: Blob | null, status: number) => void} onItem
 */
export async function readPreviewBatch(response, count, onItem) {
  if (
    !response.ok ||
    response.headers.get('content-type') !== PREVIEW_CONTENT_TYPE ||
    !response.body
  )
    throw Error('Preview batch unavailable')
  const reader = response.body.getReader()
  const seen = new Set()
  let buffer = new Uint8Array()
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.length
      if (total > count * (PREVIEW_BYTE_LIMIT + 1028)) throw Error('Oversized preview batch')
      const joined = new Uint8Array(buffer.length + value.length)
      joined.set(buffer)
      joined.set(value, buffer.length)
      buffer = joined
      while (buffer.length >= 4) {
        const headerSize = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0)
        if (!headerSize || headerSize > 1024) throw Error('Invalid preview frame')
        if (buffer.length < 4 + headerSize) break
        const header = JSON.parse(new TextDecoder().decode(buffer.subarray(4, 4 + headerSize)))
        if (
          !Number.isInteger(header.index) ||
          header.index < 0 ||
          header.index >= count ||
          seen.has(header.index) ||
          !Number.isInteger(header.length) ||
          header.length < 0 ||
          header.length > PREVIEW_BYTE_LIMIT ||
          ![200, 304, 404, 502].includes(header.status) ||
          (header.status === 200 &&
            (!header.length || !['image/jpeg', 'image/png', 'image/webp'].includes(header.type))) ||
          (header.status !== 200 && header.length !== 0)
        )
          throw Error('Invalid preview frame')
        const end = 4 + headerSize + header.length
        if (buffer.length < end) break
        seen.add(header.index)
        onItem(
          header.index,
          header.status === 200
            ? new Blob([buffer.slice(4 + headerSize, end)], { type: header.type })
            : null,
          header.status,
        )
        buffer = buffer.slice(end)
      }
    }
    if (buffer.length || seen.size !== count) throw Error('Incomplete preview batch')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function facePreviewPath(path) {
  return (
    typeof path === 'string' &&
    /^faces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/.test(path)
  )
}
