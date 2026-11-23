/** A write belongs to the gallery/photo that started it, even if navigation wins the race. */
export function createScopedMutation(changed: () => void) {
  let scope = ''
  let generation = 0
  let active = true
  const pending = new Map<string, symbol>()
  return {
    setScope(next: string) {
      if (next !== scope) {
        scope = next
        generation++
      }
    },
    busy: () => pending.has(scope),
    currentScope() {
      const owner = scope
      const version = generation
      return () => active && scope === owner && generation === version
    },
    activate() {
      active = true
    },
    dispose() {
      active = false
      generation++
    },
    async run<T>(options: {
      request: () => Promise<T>
      commit: (value: T) => void
      failed: (error: unknown) => void
    }) {
      if (!active || pending.has(scope)) return
      const owner = scope
      const version = generation
      const token = Symbol()
      pending.set(owner, token)
      changed()
      try {
        const value = await options.request()
        if (active && scope === owner && generation === version) options.commit(value)
      } catch (error) {
        if (active && scope === owner && generation === version) options.failed(error)
      } finally {
        if (pending.get(owner) === token) pending.delete(owner)
        if (active) changed()
      }
    },
  }
}
