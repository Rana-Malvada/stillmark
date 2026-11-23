'use client'
import { useEffect, useRef, useState } from 'react'
import { mergePeoplePage } from './people-page'
import { latestRequest } from '@/lib/latest-request'
import type { PeopleOptionsPage } from '@/lib/people/people-options'
import { isPeopleOptionsPage } from '@/lib/people/people-options-contract'
import { ClientResponseError, readClientResponse } from '@/lib/client-response'

/** No prefetch on photo open. Search changes cancel obsolete requests. */
export function usePeopleOptions(enabled: boolean, query: string, details = false) {
  const requests = useRef(latestRequest())
  const [page, setPage] = useState<PeopleOptionsPage>({ people: [], nextCursor: null })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const failedCursor = useRef<string | undefined>(undefined)
  async function load(cursor?: string) {
    const request = requests.current.begin()
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ q: query })
      if (details) params.set('details', 'true')
      if (cursor) params.set('cursor', cursor)
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45000)])
      const response = await fetch(`/api/people/options?${params}`, {
        signal,
        cache: 'no-store',
      })
      const result = await readClientResponse<PeopleOptionsPage>(
        response,
        'Unable to load names. Please retry.',
        (value): value is PeopleOptionsPage => isPeopleOptionsPage(value, details),
      )
      signal.throwIfAborted()
      if (!request.current()) return
      failedCursor.current = undefined
      setPage((previous) => {
        return {
          people: mergePeoplePage(cursor ? previous.people : [], result.people),
          nextCursor: result.nextCursor,
        }
      })
    } catch (e) {
      if (request.current()) {
        failedCursor.current = cursor
        if (e instanceof ClientResponseError && [401, 403, 404].includes(e.status)) {
          setPage({ people: [], nextCursor: null })
          failedCursor.current = undefined
        }
        setError(e instanceof Error ? e.message : 'Unable to load names. Please retry.')
      }
    } finally {
      if (request.current()) setLoading(false)
    }
  }
  useEffect(() => {
    const owner = requests.current
    owner.cancel()
    failedCursor.current = undefined
    setPage({ people: [], nextCursor: null })
    setError('')
    setLoading(enabled)
    if (!enabled) return
    const timer = setTimeout(() => void load(), 200)
    return () => {
      clearTimeout(timer)
      owner.cancel()
    }
    // The request is deliberately scoped to this exact query/open state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, query, details])
  return {
    ...page,
    loading,
    error,
    retry: () => {
      if (enabled && !loading) void load(failedCursor.current)
    },
    more: () => {
      if (enabled && !loading && page.nextCursor) void load(page.nextCursor)
    },
  }
}
