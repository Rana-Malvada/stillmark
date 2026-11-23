// One mounted map only: short-lived, bounded, never shared across users or filters.
export function createViewportCache<T>(now = () => Date.now()) {
  const entries = new Map<string, { value: T; expires: number }>()
  return {
    get(key: string) {
      const entry = entries.get(key)
      if (!entry || entry.expires <= now()) {
        entries.delete(key)
        return undefined
      }
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    put(key: string, value: T) {
      entries.delete(key)
      entries.set(key, { value, expires: now() + 15_000 })
      while (entries.size > 12) entries.delete(entries.keys().next().value!)
    },
    clear() {
      entries.clear()
    },
  }
}
