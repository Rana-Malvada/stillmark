import { useCallback, useEffect, useMemo, useState } from 'react'
import { isAccessOverview, type Overview } from '@/lib/identity/access-response'
import { createStatusLoader } from '@/lib/status-loader'
import { ClientResponseError, readClientResponse } from '@/lib/client-response'

/** Validated reads coalesce; post-write reconciliation supersedes any older response. */
export function useAccessOverview(onError: (message: string) => void) {
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const overview = useMemo(
    () =>
      createStatusLoader<Overview>({
        read: async (signal) => {
          const response = await fetch('/api/admin/access', {
            cache: 'no-store',
            signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
          })
          return readClientResponse(
            response,
            'Unable to load access. Please retry.',
            isAccessOverview,
          )
        },
        apply: setData,
        loading: setLoading,
      }),
    [],
  )
  const refresh = useCallback(
    async (afterMutation = false) => {
      try {
        if (afterMutation) await overview.refreshAfterMutation()
        else await overview.refresh()
      } catch (e) {
        if (e instanceof ClientResponseError && [401, 403, 404].includes(e.status)) setData(null)
        onError(e instanceof Error ? e.message : 'Unable to load access')
      }
    },
    [overview, onError],
  )
  useEffect(() => {
    overview.activate()
    // oxlint-disable-next-line react/set-state-in-effect -- the status loader raises its own loading flag and must start inside the activate/cancel lifecycle of this effect
    void refresh()
    return () => overview.cancel()
  }, [refresh, overview])
  return { data, loading, refresh }
}
