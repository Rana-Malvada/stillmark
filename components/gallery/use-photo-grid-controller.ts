import { useGalleryMutation } from './use-gallery-mutation'
import { ClientResponseError, readClientResponse } from '@/lib/client-response'
import { galleryQueryString } from '@/lib/gallery-query'
import { type GalleryReturnIntent, useGalleryPosition, useGalleryReturn } from '../gallery-position'
import { clearPhotoGridSnapshots, usePhotoGridData } from './use-photo-grid-data'
import { useAlbumDestinations } from './use-album-destinations'
import { useDialogViewport } from '../use-dialog-viewport'
import { useChanged } from '../use-changed'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../auth-provider'

export interface PhotoGridOptions {
  eventId?: number
  initialQuery?: string
  canEdit?: boolean
}

/** Owns selection permissions, navigation recovery and fenced bulk mutations.
 * Views consume these coordinated states without starting their own requests. */
export function usePhotoGridController({
  eventId,
  initialQuery = '',
  canEdit = false,
}: PhotoGridOptions) {
  const router = useRouter()
  const { role, canManagePersonal, username } = useAuth()
  const returnIntent = useGalleryReturn()
  const refreshedIntent = useRef<GalleryReturnIntent | null>(null)
  useEffect(() => {
    if (!eventId || !returnIntent?.returning || refreshedIntent.current === returnIntent) return
    refreshedIntent.current = returnIntent
    // Also refresh server-rendered permissions and actions on a photo return.
    router.refresh()
  }, [eventId, returnIntent, router])
  const [query, setQuery] = useState(initialQuery)
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<number[]>([])
  const [selecting, setSelecting] = useState(false)
  const { photos, loading, error, restoring, nextCursor, loadingMore, sentinel, more } =
    usePhotoGridData({ eventId, query, revision, username, returnIntent })
  useGalleryPosition(!loading && !restoring && !error, returnIntent)
  // Favorites can mix owned photos with shared read-only photos. Missing or stale
  // capabilities never grant a write; the mutation endpoint rechecks current access.
  const editableIds = useMemo(
    () => new Set(photos.filter((p) => p.canEdit === true).map((p) => p.photoId)),
    [photos],
  )
  const editable =
    canManagePersonal &&
    (eventId ? canEdit : selected.length > 0 && selected.every((id) => editableIds.has(id)))
  const showMutationActions = eventId
    ? canEdit || role === 'admin_readonly'
    : canManagePersonal || role === 'admin_readonly'
  const mixedReadOnlySelection = !eventId && canManagePersonal && selected.length > 0 && !editable
  if (useChanged(initialQuery)) setQuery(initialQuery)
  useEffect(() => {
    const restore = () => setQuery(galleryQueryString(new URLSearchParams(location.search)))
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])
  const applyQuery = (value: string) => {
    const canonical = galleryQueryString(new URLSearchParams(value))
    setQuery(canonical)
    window.history.replaceState(
      window.history.state,
      '',
      `${location.pathname}${canonical ? `?${canonical}` : ''}`,
    )
  }
  const { busy, run: mutate } = useGalleryMutation(`grid:${username}:${eventId}:${query}`)
  const [message, setMessage] = useState('')
  const [confirmTrash, setConfirmTrash] = useState(false)
  const [actionError, setActionError] = useState('')
  const trashDialog = useRef<HTMLDialogElement>(null)
  const trashHeading = useId()
  useDialogViewport(trashDialog)
  useEffect(() => {
    if (confirmTrash) trashDialog.current?.showModal()
    else trashDialog.current?.close()
  }, [confirmTrash])
  const {
    albums,
    destination,
    setDestination,
    cursor: albumCursor,
    loading: loadingAlbums,
    loaded: albumsLoaded,
    error: albumError,
    load: loadDestinationAlbums,
    retryCursor: albumRequestCursor,
  } = useAlbumDestinations({
    scope: `${selecting}:${eventId}:${username}:${editable}`,
    order: 'natural',
  })
  const galleryChanged = useChanged(eventId, query, revision, returnIntent)
  if (galleryChanged && returnIntent) {
    setSelected([])
    setConfirmTrash(false)
  }
  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<number>).detail === eventId) {
        clearPhotoGridSnapshots()
        setRevision((v) => v + 1)
      }
    }
    window.addEventListener('gallery-upload-complete', refresh)
    window.addEventListener('gallery-photos-updated', refresh)
    return () => {
      window.removeEventListener('gallery-upload-complete', refresh)
      window.removeEventListener('gallery-photos-updated', refresh)
    }
  }, [eventId])
  async function act(action: string) {
    if (busy || !editable || !selected.length) return
    setActionError('')
    setMessage('')
    await mutate({
      request: async () => {
        const response = await fetch('/api/photos/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(90000),
          body: JSON.stringify({
            ids: selected,
            action,
            eventId: destination ? Number(destination) : undefined,
          }),
        })
        const result = await readClientResponse<{ count: number }>(
          response,
          'Unable to update photos',
          (value): value is { count: number } =>
            typeof value === 'object' &&
            value !== null &&
            'count' in value &&
            Number.isSafeInteger(value.count) &&
            Number(value.count) >= 0,
        )
        // The server may finish after navigation; invalidate shared snapshots regardless.
        clearPhotoGridSnapshots()
        return result
      },
      commit: (data) => {
        setMessage(
          action === 'trash'
            ? `${data.count} files moved to Trash. You can restore them for 30 days.`
            : `${data.count} files updated`,
        )
        setConfirmTrash(false)
        setSelected([])
        setRevision((v) => v + 1)
        router.refresh()
      },
      failed: (error) =>
        setActionError(
          error instanceof ClientResponseError ? error.message : 'Unable to update photos',
        ),
    })
  }
  const [panel, setPanel] = useState<'add' | 'filters' | 'more' | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!panel) return
    const outside = (e: Event) => {
      const target = e.target as Element
      if (!menuRef.current?.contains(target) || !target.closest('.selection-toolbar, .media-sort'))
        setPanel(null)
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
        setPanel(null)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [panel])
  const activeFilters = Boolean(
    new URLSearchParams(query).get('media') ||
    new URLSearchParams(query).get('favorite') ||
    (new URLSearchParams(query).get('sort') && new URLSearchParams(query).get('sort') !== 'oldest'),
  )
  const togglePanel = (next: 'add' | 'filters' | 'more') =>
    setPanel((current) => (current === next ? null : next))
  const toggleSelection = () => {
    setActionError('')
    setSelecting(!selecting)
    setSelected([])
    setConfirmTrash(false)
    setPanel(null)
  }
  return {
    context: { eventId, role, canEdit, canManagePersonal, username },
    gallery: {
      photos,
      loading,
      error,
      restoring,
      nextCursor,
      loadingMore,
      sentinel,
      more,
      query,
      applyQuery,
      router,
    },
    selection: {
      selected,
      setSelected,
      selecting,
      setSelecting,
      editable,
      showMutationActions,
      mixedReadOnlySelection,
      toggleSelection,
    },
    actions: {
      busy,
      message,
      setMessage,
      actionError,
      setActionError,
      confirmTrash,
      setConfirmTrash,
      trashDialog,
      trashHeading,
      act,
    },
    destinations: {
      albums,
      destination,
      setDestination,
      albumCursor,
      loadingAlbums,
      albumsLoaded,
      albumError,
      loadDestinationAlbums,
      albumRequestCursor,
    },
    menu: { panel, setPanel, menuRef, triggerRef, activeFilters, togglePanel },
  }
}

export type PhotoGridController = ReturnType<typeof usePhotoGridController>
