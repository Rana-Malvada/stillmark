import { useRef } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { BufferedPhotoImage } from '../buffered-photo-image'
import { BufferedVideo } from '../buffered-video'
import type { PhotoDetail } from '../gallery/photo-detail-data'
import type { PhotoFace } from '../people/photo-people-panel'

type ViewerMediaStageProps = {
  photo: PhotoDetail
  loading: boolean
  fullScreen: boolean
  positionUsername: string | null
  context: string
  goTo: (id: number | null) => void
  setEditingIgnored: (selection: { photoId: number; faceId: number }) => void
  faceVisible: boolean | undefined
  detectedFaces: PhotoFace[]
  selectedFaceId: number | null | undefined
  showIgnoredFaces: boolean
  ignoredFaces: PhotoFace[]
}

/** Renders buffered media and accepts swipes only for the current, unzoomed photo. */
export function ViewerMediaStage({
  photo,
  loading,
  fullScreen,
  positionUsername,
  context,
  goTo,
  setEditingIgnored,
  faceVisible,
  detectedFaces,
  selectedFaceId,
  showIgnoredFaces,
  ignoredFaces,
}: ViewerMediaStageProps) {
  const swipe = useRef<{ x: number; y: number; time: number; photoId: number } | null>(null)
  return (
    <div className="photo-viewer-stage">
      {/* Main image area */}
      <div
        className="photo-viewer-media flex-1 min-h-0 relative flex items-center justify-center overflow-hidden"
        style={{ touchAction: 'pan-y pinch-zoom' }}
        onTouchStart={(e) => {
          swipe.current =
            !loading &&
            photo.mediaType !== 'video' &&
            e.touches.length === 1 &&
            (window.visualViewport?.scale ?? 1) === 1 &&
            !(e.target as HTMLElement).closest('button,a,input')
              ? {
                  x: e.touches[0].clientX,
                  y: e.touches[0].clientY,
                  time: Date.now(),
                  photoId: photo.photoId,
                }
              : null
        }}
        onTouchMove={(e) => {
          if (e.touches.length !== 1) swipe.current = null
        }}
        onTouchCancel={() => {
          swipe.current = null
        }}
        onTouchEnd={(e) => {
          const start = swipe.current
          swipe.current = null
          if (
            !start ||
            loading ||
            start.photoId !== photo.photoId ||
            !e.changedTouches.length ||
            (window.visualViewport?.scale ?? 1) !== 1
          )
            return
          const dx = e.changedTouches[0].clientX - start.x
          const dy = e.changedTouches[0].clientY - start.y
          if (
            Date.now() - start.time < 1000 &&
            Math.abs(dx) >= 50 &&
            Math.abs(dx) > Math.abs(dy) * 1.5
          )
            void goTo(dx < 0 ? photo.next : photo.prev)
        }}
      >
        {/* Image or Video */}
        {photo.mediaType === 'video' ? (
          photo.displayUrl || photo.originalUrl ? (
            <BufferedVideo
              photoId={photo.photoId}
              key={photo.photoId}
              src={photo.displayUrl || photo.originalUrl || undefined}
              controls
              autoPlay
              playsInline
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <div className="text-foreground/40">No video available</div>
          )
        ) : photo.displayUrl ? (
          <BufferedPhotoImage
            photo={{
              photoId: photo.photoId,
              url: photo.displayUrl,
              width: photo.width,
              height: photo.height,
            }}
            neighbors={photo.preload ?? []}
            scope={`${positionUsername ?? ''}:${context}:${new URLSearchParams(context).get('context') === 'favorites' ? 'favorites' : photo.eventId}`}
            alt={photo.sourceFilename}
            fullScreen={fullScreen}
            onIgnoredFaceClick={(faceId) => setEditingIgnored({ photoId: photo.photoId, faceId })}
            highlights={[
              ...(faceVisible
                ? detectedFaces.map((face) => ({
                    faceId: face.faceId,
                    box: face.box!,
                    selected: face.faceId === selectedFaceId,
                    label: face.personName
                      ? `${face.personName}${face.status === 'suggested' ? '?' : ''}`
                      : 'Unknown person',
                  }))
                : []),
              ...(showIgnoredFaces
                ? ignoredFaces.map((face) => ({
                    faceId: face.faceId,
                    box: face.box!,
                    selected: false,
                    ignored: true,
                    label: `Ignored${face.personName ? ': ' + face.personName : ' face'}`,
                  }))
                : []),
            ]}
          />
        ) : (
          <div className="text-foreground/40">No display image available</div>
        )}
      </div>
      <div
        className="photo-viewer-navigation shrink-0 flex items-center justify-center gap-6 py-2 text-foreground"
        style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }}
      >
        <button
          aria-label="Previous photo"
          disabled={loading || !photo.prev}
          onClick={() => goTo(photo.prev)}
          className="rounded-full p-3 bg-foreground/10 disabled:opacity-30"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
        <button
          aria-label="Next photo"
          disabled={loading || !photo.next}
          onClick={() => goTo(photo.next)}
          className="rounded-full p-3 bg-foreground/10 disabled:opacity-30"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      </div>
    </div>
  )
}
