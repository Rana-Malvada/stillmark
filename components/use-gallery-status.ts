'use client'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { ClientResponseError, readClientResponse } from '@/lib/client-response'
import { createStatusLoader } from '@/lib/status-loader'
import { type GalleryStatus, isGalleryStatus } from '@/lib/gallery-status-contract'

const unavailable = 'Unable to load gallery status. Please retry.'

/** Mounted only while Stats is open. No background polling or automatic mutation retries. */
export function useGalleryStatus(canManage: boolean) {
  const [stats, setStats] = useState<GalleryStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mutating, setMutating] = useState(false)
  const mutation = useRef<AbortController | null>(null)
  const lifecycle = useRef(0)
  const loader = useMemo(
    () =>
      createStatusLoader<GalleryStatus>({
        async read(signal) {
          const response = await fetch('/api/stats', {
            cache: 'no-store',
            signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
          })
          return readClientResponse(response, unavailable, isGalleryStatus)
        },
        apply(value) {
          setStats(value)
          setError('')
        },
        loading: setLoading,
      }),
    [],
  )

  function failed(reason: unknown, fallback: string) {
    if (reason instanceof ClientResponseError && [401, 403, 404].includes(reason.status))
      setStats(null)
    setError(fallback)
  }
  async function refresh() {
    try {
      await loader.refresh()
    } catch (reason) {
      failed(reason, unavailable)
    }
  }
  const loadOnOpen = useEffectEvent(() => void refresh())
  useEffect(() => {
    lifecycle.current++
    loader.activate()
    loadOnOpen()
    return () => {
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- a lifecycle counter, not a DOM node: cleanup must bump the live value to fence a pending mutation
      lifecycle.current++
      loader.cancel()
      mutation.current?.abort()
      mutation.current = null
    }
  }, [loader])

  async function mutate(url: '/api/search-sync' | '/api/ai-categorize', body: object) {
    if (!canManage || mutation.current) return
    const controller = new AbortController()
    const started = lifecycle.current
    mutation.current = controller
    setMutating(true)
    setError('')
    let accepted = false
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
      })
      if (!response.ok) throw new ClientResponseError('Request failed', response.status)
      accepted = true
      if (started === lifecycle.current) await loader.refreshAfterMutation()
    } catch (reason) {
      if (started === lifecycle.current)
        failed(
          reason,
          accepted
            ? 'Request accepted, but status could not be refreshed. Retry status to check progress.'
            : 'Unable to confirm the request. Check Activity before trying again.',
        )
    } finally {
      if (started === lifecycle.current) {
        mutation.current = null
        setMutating(false)
      }
    }
  }
  return { stats, loading, error, mutating, refresh, mutate }
}
