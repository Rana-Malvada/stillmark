/** Cancellation destroys the physical connection; it can never be reused with
 * a running query/transaction. Normal release and cancellation race safely.
 * A canceled COMMIT is ambiguous and must not trigger automatic write retries. */
export function databaseClientLifetime(
  client: { release: (destroy?: boolean) => void },
  signal?: AbortSignal,
) {
  let released = false
  const release = (destroy = false) => {
    if (released) return
    released = true
    signal?.removeEventListener('abort', abort)
    client.release(destroy)
  }
  const abort = () => release(true)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  return {
    release,
    get released() {
      return released
    },
  }
}
