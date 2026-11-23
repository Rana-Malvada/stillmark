import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { galleryReturnPath } from '@/lib/gallery-query'
import { galleryParent, requestGalleryReturn } from '../gallery-position'
import type { PhotoDetail } from '../gallery/photo-detail-data'

type ViewerNavigationOptions = {
  photoId: number
  context: string
  initialFaceId: number | null
  faceSelection: { photoId: number; faceId: number | null; visible: boolean } | null
  photo: PhotoDetail | null
  loading: boolean
  loadPhoto: (id: number) => Promise<void>
  positionUsername: string | null
  showInfo: boolean
  setShowInfo: Dispatch<SetStateAction<boolean>>
  setShowMap: Dispatch<SetStateAction<boolean>>
}

/** Coordinates route and in-place fullscreen navigation with keyboard and return history. */
export function useViewerNavigation({
  photoId,
  context,
  initialFaceId,
  faceSelection,
  photo,
  loading,
  loadPhoto,
  positionUsername,
  showInfo,
  setShowInfo,
  setShowMap,
}: ViewerNavigationOptions) {
  const router = useRouter()
  const returnPath = galleryReturnPath(
    photo?.eventId,
    context,
    galleryParent(positionUsername, `photo-grid:${photo?.eventId}`, ''),
  )
  const viewerRef = useRef<HTMLDivElement>(null)
  const nativeFullscreen = useRef(false)
  const [fullScreen, setFullScreen] = useState(false)
  const exitFullScreen = useCallback(async () => {
    setFullScreen(false)
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
    if (photo) {
      const params = new URLSearchParams(context)
      if (faceSelection?.photoId === photo.photoId && faceSelection.faceId)
        params.set('face', String(faceSelection.faceId))
      else if (photo.photoId === photoId && initialFaceId) params.set('face', String(initialFaceId))
      router.replace(`/photos/${photo.photoId}?${params}`)
    }
  }, [photo, router, context, faceSelection, photoId, initialFaceId])
  const enterFullScreen = async () => {
    setShowInfo(false)
    setShowMap(false)
    setFullScreen(true)
    // iPhone browsers without element fullscreen still get an edge-to-edge viewer.
    try {
      await viewerRef.current?.requestFullscreen?.()
    } catch {
      /* Keep the viewport fallback. */
    }
  }
  useEffect(() => {
    const changed = () => {
      if (document.fullscreenElement === viewerRef.current) nativeFullscreen.current = true
      else if (nativeFullscreen.current) {
        nativeFullscreen.current = false
        void exitFullScreen()
      }
    }
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [exitFullScreen])

  const goTo = useCallback(
    (id: number | null) => {
      if (id && !loading) {
        if (fullScreen) void loadPhoto(id)
        else router.push(`/photos/${id}?${context}`)
      }
    },
    [router, context, fullScreen, loadPhoto, loading],
  )

  useEffect(() => {
    const back = () => {
      const target = location.pathname + location.search
      if (target === returnPath) requestGalleryReturn(positionUsername, target)
    }
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  }, [positionUsername, returnPath])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select,dialog')) return
      if (e.key === 'Escape' && showInfo) {
        e.preventDefault()
        setShowInfo(false)
        return
      }
      if (e.key === 'ArrowLeft' && photo?.prev) goTo(photo.prev)
      else if (e.key === 'ArrowRight' && photo?.next) goTo(photo.next)
      else if (e.key === 'Escape' && fullScreen) {
        e.preventDefault()
        void exitFullScreen()
      } else if (e.key === 'Escape')
        router.push(requestGalleryReturn(positionUsername, returnPath), { scroll: false })
      else if (e.key === 'i' && !fullScreen) setShowInfo((v) => !v)
    },
    [
      photo,
      goTo,
      router,
      returnPath,
      fullScreen,
      exitFullScreen,
      positionUsername,
      showInfo,
      setShowInfo,
    ],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return { viewerRef, returnPath, fullScreen, enterFullScreen, exitFullScreen, goTo }
}
