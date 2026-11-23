import { useCallback, useEffect, useRef, useState } from 'react'
import { latestRequest } from '@/lib/latest-request'
import { clearViewerImages } from '@/lib/viewer-image-buffer'
import { loadPhotoDetail, type PhotoDetail } from '../gallery/photo-detail-data'

/** Owns authorized photo reads and rejects completions from an older navigation. */
export function useViewerMedia(photoId: number, context: string) {
  const [photo, setPhoto] = useState<PhotoDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [favorite, setFavorite] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const photoRequest = useRef(latestRequest())
  useEffect(() => () => photoRequest.current.cancel(), [])
  const loadPhoto = useCallback(
    async (id: number) => {
      const request = photoRequest.current.begin()
      setLoading(true)
      setError(null)
      try {
        const data = await loadPhotoDetail(id, context, request.signal)
        if (!request.current()) return
        setPhoto(data)
        setFavorite(data.favorite)
      } catch (e) {
        if (!request.current()) return
        clearViewerImages()
        setPhoto(null)
        setError(e instanceof Error ? e.message : 'Unable to load photo')
      } finally {
        if (request.current()) setLoading(false)
      }
    },
    [context],
  )

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- loadPhoto raises the loading flag as it supersedes the previous photo's request; raising it earlier would let that request's completion clear it
    loadPhoto(photoId)
  }, [photoId, loadPhoto])

  return { photo, setPhoto, loading, favorite, setFavorite, error, setError, loadPhoto }
}
