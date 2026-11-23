import { flagNotOff } from '../flags'
/** Optional process-wide reuse, never durable storage or an authorization cache.
 * Callers must authorize before reading. No promises, per-user queues or timers.
 */
export class StorageByteCache {
  private entries = new Map<string, { data: Buffer; expires: number }>()
  bytes = 0
  constructor(
    readonly maxBytes = 32 * 1024 ** 2,
    readonly maxEntries = 128,
    readonly maxItemBytes = 8 * 1024 ** 2,
  ) {
    if (![maxBytes, maxEntries, maxItemBytes].every((n) => Number.isSafeInteger(n) && n > 0))
      throw Error('Invalid storage byte cache budget')
  }
  get size() {
    return this.entries.size
  }
  clear() {
    this.entries.clear()
    this.bytes = 0
  }
  delete(key: string) {
    const entry = this.entries.get(key)
    if (entry) this.bytes -= entry.data.length
    this.entries.delete(key)
  }
  has(key: string) {
    const entry = this.entries.get(key)
    if (entry && entry.expires <= Date.now()) this.delete(key)
    return this.entries.has(key)
  }
  set(key: string, data: Buffer, ttlMs = 10 * 60_000) {
    this.delete(key)
    if (
      !flagNotOff('STORAGE_BYTE_REUSE_ENABLED') ||
      key.length > 2048 ||
      !data.length ||
      data.length > Math.min(this.maxItemBytes, this.maxBytes)
    )
      return
    // Evict before copying; Buffer.from prevents mutation or retaining a larger backing buffer.
    while (this.entries.size >= this.maxEntries || this.bytes + data.length > this.maxBytes)
      this.delete(this.entries.keys().next().value!)
    this.entries.set(key, { data: Buffer.from(data), expires: Date.now() + ttlMs })
    this.bytes += data.length
  }
  take(key: string) {
    if (!flagNotOff('STORAGE_BYTE_REUSE_ENABLED') || !this.has(key)) return undefined
    const data = this.entries.get(key)!.data
    this.delete(key)
    return data
  }
  get(key: string) {
    if (!flagNotOff('STORAGE_BYTE_REUSE_ENABLED') || !this.has(key)) return undefined
    const entry = this.entries.get(key)!
    this.entries.delete(key)
    this.entries.set(key, entry)
    return Buffer.from(entry.data)
  }
}
// Next emits different module IDs for route and instrumentation layers. Share
// completed bytes across those copies so the budget and handoff are process-wide.
const processState = globalThis as typeof globalThis & {
  __stillmarkStorageByteCacheV1?: StorageByteCache
}
export const storageByteCache = (processState.__stillmarkStorageByteCacheV1 ??=
  new StorageByteCache())
