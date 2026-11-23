import type { CostRefreshProgress } from './cost-refresh-state'
/** Refresh may outlive an HTTP proxy timeout. Poll the saved report independently. */
export async function refreshCostUsage(
  previousAsOf: string | null,
  signal: AbortSignal,
  onProgress?: (progress: CostRefreshProgress) => void,
) {
  let completed = false
  let failure: Error | undefined
  const request = fetch('/api/costs', { method: 'POST', signal })
    .then(async (response) => {
      if (response.ok) {
        completed = true
        return
      }
      // A gateway timeout can occur while the server continues collecting usage.
      if ([408, 502, 503, 504, 524].includes(response.status)) return
      const body = await response.json().catch(() => null)
      failure = new Error(body?.error || `Usage refresh failed (${response.status}).`)
    })
    .catch(() => {
      // A lost response does not prove the server failed. Check its saved result.
    })
  const deadline = Date.now() + 15 * 60_000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    if (failure) throw failure
    if (completed) return
    await Promise.race([request, new Promise<void>((resolve) => setTimeout(resolve, 3000))])
    signal.throwIfAborted()
    if (failure) throw failure
    if (completed) return
    // Poll only small persisted metadata. A transient polling failure says nothing
    // about the independently running refresh, so keep observing without another POST.
    try {
      const response = await fetch('/api/costs?progress=1', {
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      })
      if (response.status === 401 || response.status === 403) {
        failure = new Error('Your session cannot read refresh progress. Sign in again.')
      } else if (response.ok) {
        const { asOf, ...progress } = await response.json()
        if (Array.isArray(progress.sources)) onProgress?.(progress as CostRefreshProgress)
        if (asOf && asOf !== previousAsOf) return
        if (progress.status === 'interrupted' || progress.status === 'failed')
          failure = new Error(
            progress.error || 'The refresh was interrupted. Refresh again to retry.',
          )
      }
    } catch {
      signal.throwIfAborted()
    }
    if (failure) throw failure
    // Once POST has settled, retain a bounded polling interval.
    await new Promise<void>((resolve) => setTimeout(resolve, 3000))
  }
  throw new Error('Usage is taking longer than expected. Reload the Costs page to check progress.')
}
