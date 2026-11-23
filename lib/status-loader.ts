/** Deduplicate healthy reads; a mutation must be followed by a genuinely newer read. */
export function createStatusLoader<T>(options: {
  read: (signal: AbortSignal) => Promise<T>
  apply: (value: T) => void
  loading: (value: boolean) => void
}) {
  let pending: Promise<void> | null = null
  let controller: AbortController | null = null
  let revision = 0
  let active = true
  const refresh = (): Promise<void> => {
    if (!active) return Promise.resolve()
    if (pending) return pending
    const currentRevision = revision
    controller = new AbortController()
    const signal = controller.signal
    options.loading(true)
    const request = Promise.resolve()
      .then(() => options.read(signal))
      .then((value) => {
        if (active && revision === currentRevision) options.apply(value)
      })
      .catch((error: unknown) => {
        // A superseded read must not replace the post-mutation status with its error.
        if (active && revision === currentRevision) throw error
      })
      .finally(() => {
        if (pending === request) {
          pending = null
          controller = null
          if (active) options.loading(false)
        }
      })
    pending = request
    return request
  }
  return {
    refresh,
    async refreshAfterMutation() {
      revision++
      // A stalled pre-mutation read must not hold Start/Stop/Retry open for its timeout.
      // Revision fencing also protects against transports that ignore abort.
      controller?.abort()
      controller = null
      pending = null
      await refresh()
    },
    activate() {
      active = true
    },
    cancel() {
      active = false
      revision++
      controller?.abort()
      controller = null
      pending = null
    },
  }
}
