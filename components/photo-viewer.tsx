'use client'
import { photoInfoPath } from '@/lib/photos/photo-return'
import { IgnoredFaceDialog } from './ignored-face-dialog'
import { ViewerActionsMenu } from './viewer-actions-menu'
import { SavePhotoButton } from './save-photo-button'
import { CaptureDateEditor } from '@/components/capture-date-editor'
import { PhotoLabelEditor } from '@/components/photo-label-editor'
import { validFaceBox } from '@/lib/people/face-highlight'
import { PhotoPeoplePanel, usePhotoPeople } from '@/components/people/photo-people-panel'
import { rememberGalleryParent, requestGalleryReturn } from './gallery-position'
import Link from 'next/link'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { VideoAnalysisPanel } from './video-analysis-panel'
import { useAuth } from '@/components/auth-provider'
import {
  EyeOff,
  FolderOpen,
  Heart,
  Image as ImageIcon,
  Info,
  Loader2,
  Maximize,
  Minimize,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import { PhotoMetadata } from './gallery/photo-metadata'
import { useViewerMedia } from './photo-viewer/use-viewer-media'
import { useViewerNavigation } from './photo-viewer/use-viewer-navigation'
import { useViewerActions } from './photo-viewer/use-viewer-actions'
import { ViewerMediaStage } from './photo-viewer/viewer-media-stage'

const LeafletMap = dynamic(() => import('@/components/leaflet-map'), { ssr: false })

export function PhotoViewer({
  photoId,
  context = '',
  initialFaceId = null,
  initialInfo = false,
  initialExpanded = false,
  initialInfoScroll = 0,
}: {
  photoId: number
  context?: string
  initialFaceId?: number | null
  initialInfo?: boolean
  initialExpanded?: boolean
  initialInfoScroll?: number
}) {
  const { role, canManagePersonal } = useAuth()
  const { photo, setPhoto, loading, favorite, setFavorite, error, setError, loadPhoto } =
    useViewerMedia(photoId, context)
  const {
    data: photoPeople,
    reload: reloadPeople,
    loading: peopleLoading,
    error: peopleError,
  } = usePhotoPeople(photo?.mediaType === 'photo' ? photo.photoId : null)
  const [faceSelection, setFaceSelection] = useState<{
    photoId: number
    faceId: number | null
    visible: boolean
  } | null>(null)
  const selectedFaceId =
    faceSelection?.photoId === photo?.photoId
      ? faceSelection?.faceId
      : photo?.photoId === photoId
        ? initialFaceId
        : null
  const faceVisible =
    faceSelection?.photoId === photo?.photoId
      ? faceSelection?.visible
      : photo?.photoId === photoId && initialFaceId !== null
  const [ignoredVisibleFor, setIgnoredVisibleFor] = useState<number | null>(null)
  const [editingIgnored, setEditingIgnored] = useState<{ photoId: number; faceId: number } | null>(
    null,
  )
  const canEditFaces = !!photoPeople?.canEdit && canManagePersonal && role !== 'admin_readonly'
  const ignoredFaces = canEditFaces
    ? (photoPeople?.ignoredFaces ?? []).filter((f) => f.source !== 'manual' && validFaceBox(f.box))
    : []
  const showIgnoredFaces = canEditFaces && ignoredVisibleFor === photo?.photoId
  const ignoredFace =
    editingIgnored?.photoId === photo?.photoId
      ? ignoredFaces.find((f) => f.faceId === editingIgnored?.faceId)
      : undefined
  const detectedFaces =
    photoPeople?.faces.filter((face) => face.source !== 'manual' && validFaceBox(face.box)) ?? []
  const highlightedFace = detectedFaces.find((face) => face.faceId === selectedFaceId)
  const [showInfo, setShowInfo] = useState(initialInfo)
  const [showMap, setShowMap] = useState(false)
  const router = useRouter()
  const { username: positionUsername } = useAuth()
  const { viewerRef, returnPath, fullScreen, enterFullScreen, exitFullScreen, goTo } =
    useViewerNavigation({
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
    })

  const [detailsExpanded, setDetailsExpanded] = useState(initialExpanded)
  const [infoScroll, setInfoScroll] = useState(initialInfoScroll)
  const restoredInfo = useRef(false)
  const detailsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!photo || !photoPeople || !showInfo || restoredInfo.current || !detailsRef.current) return
    restoredInfo.current = true
    detailsRef.current.scrollTop = initialInfoScroll
  }, [photo, photoPeople, showInfo, initialInfoScroll])
  const {
    mutating,
    isCurrent,
    confirmDelete,
    setConfirmDelete,
    toggleFavorite,
    handleDelete,
    chooseCover,
  } = useViewerActions({
    photoId,
    photo,
    setPhoto,
    setFavorite,
    setError,
    goTo,
    positionUsername,
    returnPath,
  })

  if (loading && !photo) {
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center z-50">
        <Loader2 className="w-8 h-8 animate-spin text-foreground/60" />
      </div>
    )
  }

  if (!photo) {
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center z-50 text-foreground">
        {error || 'Photo not found'}
      </div>
    )
  }

  return (
    <div
      ref={viewerRef}
      className="dark fixed inset-0 bg-background z-50 flex flex-col"
      style={fullScreen ? { height: '100dvh', width: '100%' } : undefined}
    >
      {fullScreen && (
        <button
          aria-label="Exit full screen"
          onClick={() => void exitFullScreen()}
          className="absolute right-3 z-30 rounded-full bg-scrim/60 p-3 text-foreground"
          style={{ top: 'max(12px, env(safe-area-inset-top))' }}
        >
          <Minimize className="w-5 h-5" />
        </button>
      )}
      {error && (
        <p role="alert" className="p-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {/* Top bar */}
      <div
        className={`${fullScreen ? 'hidden' : 'flex'} viewer-toolbar items-center justify-between gap-1 px-2 sm:px-6 py-2 z-20`}
      >
        <button
          aria-label={
            returnPath.startsWith('/search')
              ? 'Back to search results'
              : returnPath.startsWith('/people')
                ? 'Back to People'
                : new URLSearchParams(context).get('context') === 'favorites'
                  ? 'Back to Favorites'
                  : 'Back to album'
          }
          onClick={() =>
            router.push(requestGalleryReturn(positionUsername, returnPath), { scroll: false })
          }
          className="text-foreground/70 hover:text-foreground transition-colors p-2"
        >
          <X className="w-5 h-5" />
        </button>
        <div className="flex justify-end items-center gap-0 sm:gap-2">
          <button
            aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
            aria-pressed={favorite}
            disabled={mutating || !photo.canEdit}
            onClick={toggleFavorite}
            className="p-2 text-foreground/70 hover:text-foreground transition-colors"
          >
            <Heart className={`w-5 h-5 ${favorite ? 'fill-favorite text-favorite' : ''}`} />
          </button>
          <button
            onClick={() => void enterFullScreen()}
            aria-label="Enter full screen"
            title="Full screen"
            className="p-2 text-foreground/70 hover:text-foreground"
          >
            <Maximize className="w-5 h-5" />
          </button>

          <button
            aria-label="Photo details"
            onClick={() => setShowInfo((v) => !v)}
            className="p-2 text-foreground/70 hover:text-foreground transition-colors"
          >
            <Info className="w-5 h-5" />
          </button>
          <SavePhotoButton
            key={photo.photoId}
            url={photo.originalUrl}
            filename={photo.sourceFilename}
            isVideo={photo.mediaType === 'video'}
          />
          {(photo.canEdit || role === 'admin_readonly') && (
            <button
              aria-label="Move to trash"
              title="Move to trash"
              disabled={!photo.canEdit}
              onClick={() => setConfirmDelete(true)}
              className="p-2 text-foreground/70 hover:text-destructive transition-colors"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          )}
          <ViewerActionsMenu key={photo.photoId}>
            {photo.mediaType === 'photo' && (detectedFaces.length > 0 || canEditFaces) && (
              <button
                type="button"
                aria-pressed={!!faceVisible}
                disabled={!detectedFaces.length}
                onClick={() =>
                  setFaceSelection({
                    photoId: photo.photoId,
                    faceId: highlightedFace?.faceId ?? null,
                    visible: !faceVisible,
                  })
                }
                className="min-h-11 rounded border border-border text-left text-sm text-foreground disabled:opacity-40"
              >
                <UserRound aria-hidden="true" />
                {faceVisible ? 'Hide face highlights' : 'Show face highlights'}
              </button>
            )}
            {canEditFaces && photo.mediaType === 'photo' && (
              <button
                type="button"
                className="min-h-11 rounded border border-border text-left text-sm text-foreground disabled:opacity-40"
                aria-pressed={showIgnoredFaces}
                disabled={!ignoredFaces.length}
                onClick={() => setIgnoredVisibleFor(showIgnoredFaces ? null : photo.photoId)}
              >
                <EyeOff aria-hidden="true" />
                {showIgnoredFaces ? 'Hide ignored faces' : 'Show ignored faces'} (
                {ignoredFaces.length})
              </button>
            )}

            {showIgnoredFaces && (
              <p className="text-xs text-foreground/60">
                Tap a dashed face box to undo Ignore or assign a person.
              </p>
            )}
            <Link
              href={`/events/${photo.eventId}`}
              onClick={() => {
                const parent = returnPath
                if (parent.startsWith('/search'))
                  rememberGalleryParent(positionUsername, `album:${photo.eventId}`, parent)
              }}
              className="rounded border border-border px-2 py-1 text-xs text-foreground"
            >
              <FolderOpen aria-hidden="true" />
              Open album
            </Link>
            {(photo.canEdit || role === 'admin_readonly') && <hr className="my-1 border-border" />}
            {(photo.canEdit || role === 'admin_readonly') && (
              <PhotoLabelEditor
                canEdit={photo.canEdit}
                key={`labels-${photo.photoId}`}
                photoId={photo.photoId}
                caption={photo.caption}
                aiDescription={photo.aiDescription}
                tags={photo.userTags}
                onSaved={(labels) => {
                  if (!isCurrent()) return
                  setPhoto((current) =>
                    current?.photoId === photo.photoId
                      ? { ...current, caption: labels.caption, userTags: labels.tags }
                      : current,
                  )
                  setShowInfo(true)
                }}
              />
            )}
            {(photo.canEdit || role === 'admin_readonly') && (
              <CaptureDateEditor
                canEdit={photo.canEdit}
                key={photo.photoId}
                photoId={photo.photoId}
                date={photo.dateTaken}
                onSaved={() => {
                  if (isCurrent()) void loadPhoto(photo.photoId)
                }}
              />
            )}
            {(photo.canEdit || role === 'admin_readonly') && (
              <button
                disabled={!photo.canEdit || mutating || photo.isAlbumCover}
                onClick={chooseCover}
                className="rounded border border-border px-2 py-1 text-xs text-foreground disabled:opacity-60"
              >
                <ImageIcon aria-hidden="true" />
                {photo.isAlbumCover ? 'Album cover selected' : 'Set as album cover'}
              </button>
            )}

            {photo.mediaType === 'video' && role === 'admin' && (
              <button
                className="rounded border border-border px-2 py-1 text-xs text-foreground"
                onClick={() => setShowInfo(true)}
              >
                Video analysis
              </button>
            )}
          </ViewerActionsMenu>
        </div>
      </div>

      <ViewerMediaStage
        photo={photo}
        loading={loading}
        fullScreen={fullScreen}
        positionUsername={positionUsername}
        context={context}
        goTo={goTo}
        setEditingIgnored={setEditingIgnored}
        faceVisible={faceVisible}
        detectedFaces={detectedFaces}
        selectedFaceId={selectedFaceId}
        showIgnoredFaces={showIgnoredFaces}
        ignoredFaces={ignoredFaces}
      />

      {showIgnoredFaces && ignoredFace && (
        <IgnoredFaceDialog
          key={`${photo.photoId}:${ignoredFace.faceId}`}
          face={ignoredFace}
          onClose={() => setEditingIgnored(null)}
          onReconcile={reloadPeople}
          onSaved={async () => {
            await reloadPeople()
            if (!isCurrent()) return
            setFaceSelection({ photoId: photo.photoId, faceId: ignoredFace.faceId, visible: true })
            setEditingIgnored(null)
          }}
        />
      )}
      {/* Info panel */}
      {showInfo && (
        <div
          role="region"
          aria-label="Photo details"
          ref={detailsRef}
          onScroll={(event) => setInfoScroll(event.currentTarget.scrollTop)}
          className={`photo-details-sheet ${detailsExpanded ? 'is-expanded' : ''} absolute bg-card/95 backdrop-blur-md text-foreground/90 overflow-y-auto border border-border z-20`}
        >
          <div className="sticky top-0 bg-card flex items-center justify-between gap-2 py-3 border-b border-border z-10">
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-semibold text-foreground">
                {photo.mediaType === 'video' ? 'Video details' : 'Photo details'}
              </h3>
              <p
                className="mt-1 truncate text-xs text-muted-foreground"
                title={photo.sourceFilename}
              >
                {photo.sourceFilename}
              </p>
            </div>
            <button
              className="min-h-11 rounded-lg px-2 text-xs text-muted-foreground hover:bg-foreground/10 sm:hidden"
              onClick={() => setDetailsExpanded((v) => !v)}
              aria-expanded={detailsExpanded}
            >
              {detailsExpanded ? 'Reduce details' : 'Expand details'}
            </button>
            <button
              aria-label="Close details"
              onClick={() => setShowInfo(false)}
              className="min-h-11 min-w-11 rounded-lg flex items-center justify-center hover:bg-foreground/10"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {photo.mediaType === 'video' && (
            <VideoAnalysisPanel key={photo.photoId} photoId={photo.photoId} />
          )}
          {photo.mediaType !== 'video' && (
            <PhotoPeoplePanel
              key={photo.photoId}
              photoId={photo.photoId}
              returnToPhoto={photoInfoPath(
                photo.photoId,
                context,
                detailsExpanded,
                faceVisible ? (selectedFaceId ?? null) : null,
                infoScroll,
              )}
              readOnly={role === 'admin_readonly'}
              data={photoPeople}
              reload={reloadPeople}
              loading={peopleLoading}
              loadError={peopleError}
              selectedFaceId={faceVisible ? (highlightedFace?.faceId ?? null) : null}
              onSelectFace={(faceId) => {
                setFaceSelection({ photoId: photo.photoId, faceId, visible: true })
                // The mobile details sheet covers the image; dismiss it to reveal the selection.
                if (window.matchMedia('(max-width: 639px)').matches) setShowInfo(false)
              }}
            />
          )}
          <PhotoMetadata photo={photo} onShowMap={() => setShowMap(true)} />
        </div>
      )}

      {/* Map modal */}
      {showMap && photo.latitude != null && photo.longitude != null && (
        <div
          className="absolute inset-0 bg-scrim/80 flex items-center justify-center z-30"
          onClick={() => setShowMap(false)}
        >
          <div
            className="relative w-[90%] max-w-2xl rounded-xl overflow-hidden border border-primary"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setShowMap(false)}
              className="absolute top-3 right-3 z-10 p-1.5 rounded-full bg-scrim/60 text-foreground hover:bg-scrim/80 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
            <LeafletMap lat={photo.latitude} lng={photo.longitude} zoom={12} />
            <div className="bg-scrim/70 px-4 py-2 flex items-center justify-between">
              <span className="text-xs text-foreground/70">
                {photo.latitude.toFixed(6)}, {photo.longitude.toFixed(6)}
              </span>
              <a
                href={`https://maps.google.com/?q=${photo.latitude},${photo.longitude}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:text-primary underline"
              >
                Open in Google Maps
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="absolute inset-0 bg-scrim/80 flex items-center justify-center z-30">
          <div className="bg-card text-card-foreground rounded-xl p-6 max-w-sm mx-4 space-y-4">
            <h3 className="text-lg font-semibold">
              Delete this {photo.mediaType === 'video' ? 'video' : 'photo'}?
            </h3>
            <p className="text-sm text-muted-foreground">
              This moves the file to Trash. You can restore it for 30 days before it is permanently
              removed.
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={mutating}
                className="px-4 py-2 text-sm rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
