'use client'
import { useEffect, useRef, useState } from 'react'
import { mergeAlbumPages, restoreAlbumPages } from '@/lib/restore-album-pages'
import {
  type EventData,
  eventPageUrl,
  type FolderData,
  loadEventFolders,
  loadEventPage,
} from './event-grid-data'

/** Owns current-identity reads, continuation and saved-depth restoration. */
export function useEventGridData(mine: boolean, username: string | null) {
  const [groups, setGroups] = useState<
    { section: string; folder_id: number | null; albums: number; photos: number }[]
  >([])
  const [moreBusy, setMoreBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const requestGeneration = useRef(0)
  const depthKey = `album-folder-pages:v2:${username}:${mine ? 'mine' : 'collection'}`
  const [events, setEvents] = useState<EventData[]>([])
  const [folders, setFolders] = useState<FolderData[]>([])
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState(true)
  const [folderError, setFolderError] = useState('')

  useEffect(() => {
    if (!username) return
    const controller = new AbortController()
    requestGeneration.current++
    // oxlint-disable-next-line react/set-state-in-effect -- the reset must follow the generation bump in this effect, or a late loadMore for the old identity could repopulate the list
    setEvents([])
    setFolders([])
    setGroups([])
    setMoreBusy(false)
    setLoading(true)
    setRestoring(true)
    setFolderError('')
    void (async () => {
      try {
        const [page, flds] = await Promise.all([
          loadEventPage(
            `/api/events?paged=true&scope=${mine ? 'mine' : 'accessible'}`,
            controller.signal,
            true,
          ),
          loadEventFolders(controller.signal),
        ])
        if (controller.signal.aborted) return
        setEvents(page.items)
        setGroups(page.groups ?? [])
        setFolders(flds)
        setLoading(false)
        const items: EventData[] = page.items
        let restored: string[] = []
        try {
          const saved = JSON.parse(sessionStorage.getItem(depthKey) || '[]')
          if (Array.isArray(saved))
            restored = saved.filter(
              (v): v is string => typeof v === 'string' && v.startsWith('/api/events?paged=true&'),
            )
        } catch {
          // Storage blocked or the saved depth is corrupt: show the first page only.
        }
        await restoreAlbumPages(
          items,
          restored,
          (url) => loadEventPage(url, controller.signal),
          setEvents,
          controller.signal,
        )
      } catch {
        if (!controller.signal.aborted)
          setFolderError('Unable to load albums. Please refresh to retry.')
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
          setRestoring(false)
        }
      }
    })()
    return () => {
      controller.abort()
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- a generation counter, not a DOM node: cleanup must bump the live value to fence loadMore
      requestGeneration.current++
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- revision is the reload trigger set by callers after a folder or album write
  }, [mine, username, depthKey, revision])
  async function loadMore(section: string, folderId: number | null, loaded: EventData[]) {
    if (moreBusy || restoring) return
    const generation = requestGeneration.current
    setMoreBusy(true)
    setFolderError('')
    try {
      const url = eventPageUrl(mine, section, folderId, loaded)
      const page = await loadEventPage(url)
      if (generation !== requestGeneration.current) return
      setEvents((current) => mergeAlbumPages<EventData>(current, page.items))
      try {
        const saved = JSON.parse(sessionStorage.getItem(depthKey) || '[]')
        sessionStorage.setItem(
          depthKey,
          JSON.stringify([...new Set([...(Array.isArray(saved) ? saved : []), url])]),
        )
      } catch {
        // Storage blocked or full: the page is shown, its depth just is not remembered.
      }
    } catch {
      if (generation === requestGeneration.current)
        setFolderError('Unable to load more albums. Please try again.')
    } finally {
      if (generation === requestGeneration.current) setMoreBusy(false)
    }
  }

  return {
    events,
    folders,
    groups,
    loading,
    restoring,
    moreBusy,
    folderError,
    setFolderError,
    setFolders,
    setRevision,
    loadMore,
  }
}
