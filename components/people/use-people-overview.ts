import { useCallback, useEffect, useRef, useState } from 'react'
import { latestRequest } from '@/lib/latest-request'
import { ClientResponseError } from '@/lib/client-response'
import {
  isPeopleSettings,
  loadPeopleOverview,
  type PeopleOverview as Overview,
} from '@/lib/people/people-overview-contract'
import { peopleApi } from '@/lib/people/people-client'
import type { Settings } from './types'
import { mergePeoplePage } from './people-page'

/** One request owner for an overview kind and its subsequent pages. */
export function usePeopleOverview(overviewKind: string) {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loadedKind, setLoadedKind] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState('')

  const [loadingMorePeople, setLoadingMorePeople] = useState(false)
  const loadingRequest = useRef(latestRequest())
  useEffect(() => () => loadingRequest.current.cancel(), [])
  const load = useCallback(async () => {
    const request = loadingRequest.current.begin()
    setLoadingMorePeople(false)
    try {
      const [o, s] = await Promise.all([
        loadPeopleOverview(`/api/people?paged=true&kind=${overviewKind}`, request.signal),
        peopleApi<Settings>(
          '/api/people/settings',
          'GET',
          undefined,
          request.signal,
          isPeopleSettings,
        ),
      ])
      if (!request.current()) return
      setOverview(o)
      setLoadedKind(overviewKind)
      setSettings(s)
      setError('')
    } catch (e) {
      if (!request.current()) return
      if (e instanceof ClientResponseError && [401, 403, 404].includes(e.status)) {
        setOverview(null)
        setSettings(null)
      }
      setError(e instanceof Error ? e.message : 'Unable to load People')
    }
  }, [overviewKind])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the clear must run with the load that cancels the previous kind's request, or its late failure could show under the new kind
    setError('')
    void load()
  }, [load])

  async function loadMorePeople() {
    if (loadingMorePeople || !overview?.nextCursor) return
    const request = loadingRequest.current.begin()
    setLoadingMorePeople(true)
    try {
      const next = await loadPeopleOverview(
        `/api/people?paged=true&summary=false&kind=${overviewKind}&cursor=${encodeURIComponent(overview.nextCursor)}`,
        request.signal,
        false,
      )
      if (!request.current()) return
      setOverview((current) =>
        current
          ? {
              ...current,
              named: mergePeoplePage(current.named, next.named),
              unnamed: mergePeoplePage(current.unnamed, next.unnamed),
              hidden: mergePeoplePage(current.hidden, next.hidden),
              nextCursor: next.nextCursor,
              more: next.more,
            }
          : current,
      )
      setError('')
    } catch (e) {
      if (request.current()) setError(e instanceof Error ? e.message : 'Unable to load more people')
    } finally {
      if (request.current()) setLoadingMorePeople(false)
    }
  }

  return { overview, settings, error, load, loadMorePeople, loadingMorePeople, loadedKind }
}
