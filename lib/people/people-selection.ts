/** Per-tab selection memory, scoped to the signed-in user and People list. */
export function selectionKey(username: string | null, scope: string) {
  return username ? `people-selection-v1:${JSON.stringify([username, scope])}` : null
}

export function readSelection(key: string | null): { ids: string[]; loaded: number } {
  try {
    const saved = key ? JSON.parse(sessionStorage.getItem(key) || 'null') : null
    if (saved && Array.isArray(saved.ids))
      return {
        ids: saved.ids.filter((id: unknown) => typeof id === 'string' && /^[1-9]\d*$/.test(id)),
        loaded: Number.isSafeInteger(saved.loaded) && saved.loaded > 0 ? saved.loaded : 0,
      }
  } catch {
    // Storage blocked or the saved value is corrupt: start with an empty selection.
  }
  return { ids: [], loaded: 0 }
}

export function writeSelection(key: string | null, ids: Iterable<number>, loaded: number) {
  if (!key) return
  try {
    sessionStorage.setItem(key, JSON.stringify({ ids: [...ids].map(String), loaded }))
  } catch {
    // Storage blocked or full: the selection still works, it just is not remembered.
  }
}

export function restoreSelection(saved: string[], available: number[]) {
  const wanted = new Set(saved)
  // Match both numeric API IDs and bigint IDs serialized as strings; retain the
  // actual API value so the grid's Set membership and requests stay consistent.
  return new Set(available.filter((id) => wanted.has(String(id))))
}
