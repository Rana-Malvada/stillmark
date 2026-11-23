// Numeric-only timings. Never retain a media path, URL, response, or visitor identity.
// The emergency log ceiling is per isolate, not a global rate limit.

/**
 * @typedef {import('../public/preview-batch.mjs').PreviewBatchEvent} PreviewBatchEvent
 * @typedef {{ index: number, startMs?: number, headerMs?: number, bodyMs?: number, frameMs?: number, status?: number, bytes?: number }} ItemTiming
 */

/** @param {{ now?: () => number, log?: (line: string) => void }} [options] */
export function createPreviewBatchRecorder({ now = Date.now, log = console.warn } = {}) {
  let minute = -1
  let writes = 0
  // A missing measurement rounds to NaN and is recorded as 0.
  /** @param {number | undefined} value */
  const ms = (value) =>
    Math.min(3600000, Math.max(0, Math.round(/** @type {number} */ (value)) || 0))
  /**
   * @param {Env} env
   * @param {{ signingMs: number, count: number, reused: number }} batch
   * @returns {((event: PreviewBatchEvent) => void) | undefined}
   */
  return function observe(env, { signingMs, count, reused }) {
    if (env.GATEWAY_DIAGNOSTICS !== 'enabled') return undefined
    /** @type {ItemTiming[]} */
    const items = Array.from({ length: Math.min(8, count) }, (_, index) => ({ index }))
    let firstFrameMs = -1
    let lastFrameMs = -1
    return (event) => {
      if (event.type !== 'complete') {
        const item = items[event.index]
        if (!item) return
        if (event.type === 'item-start') item.startMs = ms(event.elapsedMs)
        if (event.type === 'item-headers') item.headerMs = ms(event.headerMs)
        if (event.type === 'item-body') {
          item.headerMs = ms(event.headerMs ?? item.headerMs)
          item.bodyMs = ms(event.bodyMs)
          item.status = event.status
          item.bytes = event.bytes
        }
        if (event.type === 'item-frame') {
          item.frameMs = ms(event.elapsedMs)
          if (firstFrameMs < 0) firstFrameMs = item.frameMs
          lastFrameMs = item.frameMs
        }
        return
      }
      const elapsedMs = ms(signingMs) + ms(event.elapsedMs)
      const failedItem = items.some((item) => item.status === 502 || item.status === 499)
      if (elapsedMs < 2000 && event.status === 200 && !failedItem) return
      const bucket = Math.floor(now() / 60000)
      if (bucket !== minute) {
        minute = bucket
        writes = 0
      }
      if (writes >= 20) return
      writes++
      log(
        JSON.stringify({
          event: 'preview_batch_phases',
          status: event.status,
          count: items.length,
          reused,
          signingMs: ms(signingMs),
          streamMs: ms(event.elapsedMs),
          firstFrameMs,
          lastFrameMs,
          bytes: event.bytes,
          items,
        }),
      )
    }
  }
}

export const observePreviewBatch = createPreviewBatchRecorder()
