type AlbumOrder = { eventId: number; sortOrder: number }
export function mergeAlbumPages<T extends AlbumOrder>(existing: T[], incoming: T[]): T[] {
  return [...new Map([...existing, ...incoming].map((item) => [item.eventId, item])).values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.eventId - b.eventId,
  )
}

/** Restore depth, not old cursors: inserts can move an old page boundary.
 * Follow fresh cursors sequentially within each folder; at most two folders
 * load concurrently so a slow folder doesn't block the others. */
export async function restoreAlbumPages<T extends AlbumOrder>(
  initial: T[],
  urls: string[],
  load: (url: string) => Promise<{ items: T[]; nextCursor?: string | null }>,
  publish: (items: T[]) => void,
  signal: AbortSignal,
) {
  const groups = new Map<string, number>()
  for (const saved of new Set(urls)) {
    const url = new URL(saved, 'https://app')
    if (
      url.origin !== 'https://app' ||
      url.pathname !== '/api/events' ||
      url.searchParams.get('paged') !== 'true'
    )
      continue
    url.searchParams.delete('cursor')
    url.searchParams.sort()
    const key = `${url.pathname}${url.search}`
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  const bounded = [...groups]
  let items = initial
  let next = 0
  let stopped = false
  async function worker() {
    try {
      while (!stopped && next < bounded.length) {
        const [base, depth] = bounded[next++]
        let cursor: string | null = null
        const seen = new Set<string>()
        // Include the initial page, which previously came from the global list.
        for (let pageIndex = 0; pageIndex <= depth; pageIndex++) {
          signal.throwIfAborted()
          if (stopped) return
          const url = new URL(base, 'https://app')
          if (cursor) url.searchParams.set('cursor', cursor)
          const page = await load(`${url.pathname}${url.search}`)
          signal.throwIfAborted()
          if (stopped) return
          items = mergeAlbumPages(items, page.items)
          publish(items)
          cursor = page.nextCursor ?? null
          if (!cursor) break
          if (seen.has(cursor)) throw new Error('Album pagination did not advance')
          seen.add(cursor)
        }
      }
    } catch (error) {
      stopped = true
      throw error
    }
  }
  signal.throwIfAborted()
  await Promise.all(Array.from({ length: Math.min(2, bounded.length) }, worker))
}
