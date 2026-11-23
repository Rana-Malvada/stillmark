'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createStatusLoader } from '@/lib/status-loader'
import { readClientResponse } from '@/lib/client-response'
import { watchProcessStatus } from '@/lib/status-polling'

/** Shared request ordering and lifecycle; each panel still owns its workflow and cadence. */
export function useProcessStatus<T>(
  url: string,
  fallback: string,
  isActive: (data: T) => boolean,
  validate?: (value: unknown) => value is T,
) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(true)
  const [updated, setUpdated] = useState<number | null>(null)
  const polling = useRef(false)
  const activePredicate = useRef(isActive)
  // Declared before the polling effect so the first response already sees this predicate.
  useEffect(() => {
    activePredicate.current = isActive
  })
  const loader = useMemo(
    () =>
      // oxlint-disable-next-line react/refs -- read and apply run when a response arrives, never during render
      createStatusLoader<T>({
        async read(signal) {
          const response = await fetch(url, {
            cache: 'no-store',
            signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
          })
          return readClientResponse(response, fallback, validate)
        },
        apply(value) {
          polling.current = activePredicate.current(value)
          setData(value)
          // oxlint-disable-next-line react/purity -- apply runs when a response arrives, never during render
          setUpdated(Date.now())
          setError('')
        },
        loading: setRefreshing,
      }),
    [url, fallback, validate],
  )
  useEffect(() => {
    loader.activate()
    const refresh = () => {
      if (!document.hidden)
        void loader
          .refresh()
          .catch((e: unknown) => setError(e instanceof Error ? e.message : fallback))
    }
    refresh()
    const stop = watchProcessStatus(refresh, () => polling.current)
    return () => {
      stop()
      loader.cancel()
    }
  }, [loader, fallback, polling])
  return {
    data,
    error,
    setError,
    refreshing,
    updated,
    load: loader.refresh,
    refreshAfterMutation: loader.refreshAfterMutation,
  }
}
