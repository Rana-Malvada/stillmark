import { type Dispatch, type SetStateAction, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ClientResponseError, readClientResponse } from '@/lib/client-response'
import { useGalleryMutation } from '../gallery/use-gallery-mutation'
import { requestGalleryReturn } from '../gallery-position'
import type { PhotoDetail } from '../gallery/photo-detail-data'

const changedPhoto = (value: unknown): value is { ok: true } =>
  typeof value === 'object' && value !== null && 'ok' in value && value.ok === true

type ViewerActionsOptions = {
  photoId: number
  photo: PhotoDetail | null
  setPhoto: Dispatch<SetStateAction<PhotoDetail | null>>
  setFavorite: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string | null>>
  goTo: (id: number | null) => void
  positionUsername: string | null
  returnPath: string
}

/** Keeps writes and editor callbacks fenced to their owning photo without replaying them. */
export function useViewerActions({
  photoId,
  photo,
  setPhoto,
  setFavorite,
  setError,
  goTo,
  positionUsername,
  returnPath,
}: ViewerActionsOptions) {
  const router = useRouter()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const {
    busy: mutating,
    run: mutate,
    isCurrent,
  } = useGalleryMutation(`photo:${photoId}:${photo?.photoId ?? photoId}`)
  const mutationError = (fallback: string) => (error: unknown) =>
    setError(error instanceof ClientResponseError ? error.message : fallback)
  const toggleFavorite = async () => {
    if (!photo || mutating) return
    setError(null)
    await mutate({
      request: async () =>
        readClientResponse<{ favorite: boolean }>(
          await fetch(`/api/photos/${photo.photoId}/favorite`, {
            method: 'POST',
            signal: AbortSignal.timeout(45000),
          }),
          'Unable to update favorite',
          (value): value is { favorite: boolean } =>
            typeof value === 'object' &&
            value !== null &&
            'favorite' in value &&
            typeof value.favorite === 'boolean',
        ),
      commit: (data) => setFavorite(data.favorite),
      failed: mutationError('Unable to update favorite'),
    })
  }
  const handleDelete = async () => {
    if (!photo || mutating) return
    setError(null)
    await mutate({
      request: async () =>
        readClientResponse(
          await fetch(`/api/photos/${photo.photoId}`, {
            method: 'DELETE',
            signal: AbortSignal.timeout(45000),
          }),
          'Unable to delete photo',
          changedPhoto,
        ),
      commit: () => {
        if (photo.next) goTo(photo.next)
        else if (photo.prev) goTo(photo.prev)
        else router.push(requestGalleryReturn(positionUsername, returnPath), { scroll: false })
        setConfirmDelete(false)
      },
      failed: mutationError('Unable to delete photo'),
    })
  }
  const chooseCover = async () => {
    if (!photo || mutating) return
    setError(null)
    await mutate({
      request: async () =>
        readClientResponse(
          await fetch(`/api/photos/${photo.photoId}`, {
            method: 'PATCH',
            signal: AbortSignal.timeout(45000),
          }),
          'Unable to set album cover',
          changedPhoto,
        ),
      commit: () => {
        setPhoto((current) =>
          current?.photoId === photo.photoId ? { ...current, isAlbumCover: true } : current,
        )
        router.refresh()
      },
      failed: mutationError('Unable to set album cover'),
    })
  }

  return {
    mutating,
    isCurrent,
    confirmDelete,
    setConfirmDelete,
    toggleFavorite,
    handleDelete,
    chooseCover,
  }
}
