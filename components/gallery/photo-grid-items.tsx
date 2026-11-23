import Link from 'next/link'
import { Loader2, Play } from 'lucide-react'
import { VirtualPhotoGrid } from '../virtual-photo-grid'
import { PhotoCard } from '../photo-card'
import { rememberGalleryPosition } from '../gallery-position'
import { galleryViewerContext } from '@/lib/gallery-query'
import type { PhotoGridController } from './use-photo-grid-controller'

/** Rendering stays virtualized; preview admission remains owned by PhotoCard. */
export function PhotoGridItems({
  grid,
}: {
  grid: Pick<PhotoGridController, 'context' | 'gallery' | 'selection' | 'actions'>
}) {
  const { eventId, username } = grid.context
  const { photos, loading, error, query, router } = grid.gallery
  const { selected, setSelected, selecting } = grid.selection
  const { busy, setConfirmTrash } = grid.actions
  return loading ? (
    <div className="flex justify-center p-12">
      <Loader2 aria-label="Loading photos" className="animate-spin" />
    </div>
  ) : error ? null : !photos.length ? (
    <p className="py-12 text-center text-muted-foreground">
      {eventId
        ? 'No photos match these filters.'
        : 'No favorites match these filters. Open a photo or video and tap the heart to add it here.'}
    </p>
  ) : (
    <VirtualPhotoGrid
      items={photos}
      enabled={!!eventId}
      render={(photo) => (
        <PhotoCard
          key={photo.photoId}
          filename={photo.sourceFilename}
          thumbnailUrl={photo.thumbnailUrl}
          selected={selected.includes(photo.photoId)}
          footer={
            !eventId && (
              <div className="bg-card px-2 py-2 text-xs space-y-1">
                <Link className="block truncate hover:underline" href={`/events/${photo.eventId}`}>
                  {photo.eventName}
                </Link>
                <p className="truncate text-muted-foreground">
                  {photo.caption || photo.sourceFilename}
                </p>
              </div>
            )
          }
          disabled={busy}
          onClick={() => {
            if (selecting) {
              setConfirmTrash(false)
              setSelected((current) =>
                current.includes(photo.photoId)
                  ? current.filter((id) => id !== photo.photoId)
                  : current.length < 200
                    ? [...current, photo.photoId]
                    : current,
              )
            } else {
              rememberGalleryPosition(username, `photo-grid:${photo.eventId}`)
              router.push(`/photos/${photo.photoId}?${galleryViewerContext(query, !eventId)}`)
            }
          }}
          aria-label={`${selecting ? 'Select' : 'Open'} ${photo.sourceFilename}`}
          aria-pressed={selecting ? selected.includes(photo.photoId) : undefined}
        >
          {photo.mediaType === 'video' && (
            <Play className="absolute bottom-2 right-2 text-on-image fill-on-image" />
          )}
          {photo.favorite && (
            <span className="absolute bottom-2 left-2 bg-scrim/60 rounded px-1 text-on-image text-xs">
              ♥
            </span>
          )}
          {selecting && (
            <span className="absolute top-2 left-2 rounded bg-background px-2 py-1 text-xs">
              {selected.includes(photo.photoId) ? '✓ Selected' : 'Select'}
            </span>
          )}
        </PhotoCard>
      )}
    />
  )
}
