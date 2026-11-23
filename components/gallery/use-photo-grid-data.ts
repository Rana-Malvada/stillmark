'use client'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { GridCache } from '@/lib/grid-cache'
import {
  type GridPhoto,
  loadPhotoPage,
  loadPhotoPages,
  photoRestoreTarget,
} from '@/lib/photos/photo-grid-loader'
import type { GalleryReturnIntent } from '../gallery-position'

const snapshots = new GridCache<GridPhoto>()
export const clearPhotoGridSnapshots = () => snapshots.clear()

/** Owns pagination, authorization-before-cache reuse and stale-response fencing.
 * Rendering and selection remain with PhotoGrid. No thumbnail requests are made here. */
export function usePhotoGridData({
  eventId,
  query,
  revision,
  username,
  returnIntent,
}: {
  eventId?: number
  query: string
  revision: number
  username: string | null
  returnIntent: GalleryReturnIntent | null
}) {
  const [photos, setPhotos] = useState<GridPhoto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [restoring, setRestoring] = useState(true)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const sentinel = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const moreRequest = useRef<AbortController | null>(null)
  const pageKey = `photo-pages:${username}:${eventId}:${query}`
  const previousLoad = useRef<{ pageKey: string; revision: number } | null>(null)
  useEffect(() => {
    if (!returnIntent) return
    moreRequest.current?.abort()
    moreRequest.current = null
    const current = ++generation.current
    const controller = new AbortController()
    // Refreshes after an in-place mutation keep the range already shown. A fresh
    // album visit only restores depth when it shares the explicit scroll intent.
    const keepRange =
      previousLoad.current?.pageKey === pageKey && previousLoad.current.revision !== revision
    previousLoad.current = { pageKey, revision }
    // oxlint-disable-next-line react/set-state-in-effect -- the reset must follow the generation bump in this effect, or a late page for the previous gallery could repopulate this one
    setLoading(true)
    setRestoring(true)
    setError('')
    setNextCursor(null)
    setLoadingMore(false)
    setPhotos([])
    async function load() {
      let remembered: string | null = null
      try {
        remembered = sessionStorage.getItem(pageKey)
      } catch {
        // Storage blocked: load from the first page instead of the remembered depth.
      }
      const result = await loadPhotoPages({
        eventId,
        query,
        target: photoRestoreTarget(eventId, returnIntent!.returning || keepRange, remembered),
        snapshot:
          eventId && returnIntent!.returning && revision === 0 ? snapshots.get(pageKey) : null,
        signal: controller.signal,
        onPage(items) {
          if (!controller.signal.aborted && current === generation.current) {
            setPhotos(items)
            setLoading(false)
          }
        },
      })
      if (!controller.signal.aborted && current === generation.current) {
        setPhotos(result.items)
        setNextCursor(result.cursor)
        setRestoring(false)
        if (!result.reused) snapshots.put(pageKey, result.items, result.cursor)
      }
    }
    void load()
      .catch((e) => {
        if (!controller.signal.aborted && current === generation.current) {
          snapshots.delete(pageKey)
          setPhotos([])
          setError(e instanceof Error ? e.message : 'Unable to load photos. Try again.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && current === generation.current) {
          setLoading(false)
          setRestoring(false)
        }
      })
    return () => {
      controller.abort()
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- holds the newest continuation request, not a DOM node: cleanup must abort the live one
      moreRequest.current?.abort()
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- a generation counter: cleanup must bump the live value to fence late pages
      generation.current++
    }
  }, [eventId, query, revision, pageKey, returnIntent])
  async function more() {
    if (!nextCursor || loadingMore || loading || moreRequest.current) return
    const current = generation.current
    const controller = new AbortController()
    moreRequest.current = controller
    setLoadingMore(true)
    try {
      const data = await loadPhotoPage(eventId, query, nextCursor, controller.signal)
      if (current !== generation.current || controller.signal.aborted) return
      setPhotos((old) => {
        const ids = new Set(old.map((p) => p.photoId))
        const combined = [...old, ...data.items.filter((p: GridPhoto) => !ids.has(p.photoId))]
        snapshots.put(pageKey, combined, data.nextCursor)
        return combined
      })
      setNextCursor(data.nextCursor)
    } catch (e) {
      if (current === generation.current && !controller.signal.aborted)
        setError((e as Error).message)
    } finally {
      if (moreRequest.current === controller) moreRequest.current = null
      if (current === generation.current) setLoadingMore(false)
    }
  }
  const loadNextPage = useEffectEvent(() => void more())
  useEffect(() => {
    if (!nextCursor || loading || restoring || loadingMore || error) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadNextPage()
      },
      { rootMargin: '500px' },
    )
    if (sentinel.current) observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [nextCursor, loading, restoring, loadingMore, error])
  useEffect(() => {
    if (!loading && photos.length)
      try {
        sessionStorage.setItem(pageKey, String(photos.length))
      } catch {
        // Storage blocked or full: the photos are shown, the depth just is not remembered.
      }
  }, [photos.length, loading, pageKey])
  useEffect(() => {
    const clear = () => snapshots.clear()
    window.addEventListener('gallery-logout', clear)
    return () => window.removeEventListener('gallery-logout', clear)
  }, [])
  return { photos, loading, error, restoring, nextCursor, loadingMore, sentinel, more }
}
