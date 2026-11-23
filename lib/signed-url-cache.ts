/** Process-local URL cache. Authorization must still run before every cache lookup. */
export class SignedUrlCache {
  private entries = new Map<string, { url: string; expires: number; bytes: number }>()
  bytes = 0
  constructor(
    private maxEntries: number,
    private maxBytes: number,
  ) {
    if (![maxEntries, maxBytes].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new Error('Invalid signed URL cache budget')
  }
  get size() {
    return this.entries.size
  }
  keys() {
    return this.entries.keys()
  }
  delete(key: string) {
    const entry = this.entries.get(key)
    if (entry) this.bytes -= entry.bytes
    this.entries.delete(key)
  }
  get(key: string, now = Date.now()) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expires <= now) {
      this.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.url
  }
  set(key: string, url: string, expires: number) {
    this.delete(key)
    // Budget string payload plus a fixed allowance; entry count also bounds Map overhead.
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(url) + 128
    if (bytes > this.maxBytes || expires <= Date.now()) return 0
    let evicted = 0
    while (this.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      this.delete(this.entries.keys().next().value!)
      evicted++
    }
    this.entries.set(key, { url, expires, bytes })
    this.bytes += bytes
    return evicted
  }
}
