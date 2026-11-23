'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type AlbumDestinationOrder,
  loadAlbumDestinations,
  mergeAlbumDestinations,
} from '@/lib/albums/album-destinations'
import { latestRequest } from '@/lib/latest-request'

/** Each caller chooses its existing ordering and when to reset/load. Request
 * ownership, pagination, editable filtering and retry policy stay shared. */
export function useAlbumDestinations({
  scope,
  order,
  autoLoad = false,
}: {
  scope: string
  order: AlbumDestinationOrder
  autoLoad?: boolean
}) {
  const [albums, setAlbums] = useState<{ eventId: number; eventName: string }[]>([])
  const [destination, setDestination] = useState('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const requests = useRef(latestRequest())
  const retryCursor = useRef<string | null>(null)
  const load = useCallback(
    async (next: string | null = null) => {
      const request = requests.current.begin()
      retryCursor.current = next
      setLoading(true)
      setError('')
      try {
        const page = await loadAlbumDestinations(next, request.signal)
        if (!request.current()) return
        setAlbums((previous) => mergeAlbumDestinations(next ? previous : [], page.items, order))
        setDestination((previous) =>
          page.items.some((item) => String(item.eventId) === previous && !item.canEdit)
            ? ''
            : previous,
        )
        setCursor(page.nextCursor)
        setLoaded(true)
      } catch (failure) {
        if (request.current())
          setError(
            failure instanceof Error
              ? failure.message
              : 'Unable to load destination albums. Try again.',
          )
      } finally {
        if (request.current()) setLoading(false)
      }
    },
    [order],
  )
  useEffect(() => {
    const owner = requests.current
    owner.cancel()
    // oxlint-disable-next-line react/set-state-in-effect -- the reset must follow cancel() in this effect, or a late page for the old scope could repopulate the new one
    setAlbums([])
    setDestination('')
    setCursor(null)
    setLoading(false)
    setLoaded(false)
    setError('')
    retryCursor.current = null
    if (autoLoad) void load()
    return () => owner.cancel()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- scope is the reset trigger: a new selection context must drop the previous album list
  }, [scope, autoLoad, load])
  return { albums, destination, setDestination, cursor, loading, loaded, error, load, retryCursor }
}
