/** Short-lived metadata only. Access is revalidated before a snapshot is shown. */
const caches = new Set<{ clear: () => void }>()
export function clearGridCaches() {
  for (const cache of caches) cache.clear()
}
export class GridCache<T> {
  private values = new Map<string, { items: T[]; cursor: string | null; expires: number }>()
  constructor(
    private maxItems = 2000,
    private ttl = 30_000,
  ) {
    caches.add(this)
  }
  get(key: string) {
    const value = this.values.get(key)
    if (!value || value.expires <= Date.now()) {
      this.values.delete(key)
      return null
    }
    return value
  }
  put(key: string, items: T[], cursor: string | null) {
    this.values.delete(key)
    if (items.length > this.maxItems) return
    while (
      [...this.values.values()].reduce((n, v) => n + v.items.length, 0) + items.length >
        this.maxItems ||
      this.values.size >= 4
    )
      this.values.delete(this.values.keys().next().value!)
    this.values.set(key, { items: [...items], cursor, expires: Date.now() + this.ttl })
  }
  clear() {
    this.values.clear()
  }
  delete(key: string) {
    this.values.delete(key)
  }
}
