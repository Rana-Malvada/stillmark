/**
 * @typedef {() => void} Release Returns reserved bytes; safe to call more than once.
 * @typedef {{ bytes: number, resolve: (release: Release | null) => void, cleanup: () => void }} Waiter
 */

/**
 * Bound allocated upload buffers per isolate; queue before reading request bodies.
 * @param {{ maxBytes: number, maxWaiting?: number, waitMs?: number }} options
 * @returns {(bytes: number, signal?: AbortSignal) => Promise<Release | null>}
 */
export function createUploadAdmission({ maxBytes, maxWaiting = 32, waitMs = 5000 }) {
  let used = 0
  /** @type {Waiter[]} */
  const queue = []
  /**
   * @param {number} bytes
   * @returns {Release}
   */
  function grant(bytes) {
    used += bytes
    let released = false
    return () => {
      if (released) return
      released = true
      used -= bytes
      drain()
    }
  }
  function drain() {
    while (queue.length && used + queue[0].bytes <= maxBytes) {
      const next = /** @type {Waiter} */ (queue.shift()) // The loop condition saw an entry.
      next.cleanup()
      next.resolve(grant(next.bytes))
    }
  }
  return (bytes, signal) => {
    signal?.throwIfAborted()
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxBytes)
      throw Error('Invalid upload reservation')
    if (!queue.length && used + bytes <= maxBytes) return Promise.resolve(grant(bytes))
    if (queue.length >= maxWaiting) return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      const remove = () => {
        const index = queue.indexOf(entry)
        if (index >= 0) queue.splice(index, 1)
        entry.cleanup()
        drain()
      }
      const abort = () => {
        remove()
        // Only ever invoked for a signal that was supplied.
        reject(/** @type {AbortSignal} */ (signal).reason)
      }
      const timer = setTimeout(() => {
        remove()
        resolve(null)
      }, waitMs)
      /** @type {Waiter} */
      const entry = {
        bytes,
        resolve,
        cleanup() {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
        },
      }
      queue.push(entry)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
}
