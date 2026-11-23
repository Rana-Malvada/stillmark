import Link from 'next/link'
import { Check, UserRound } from 'lucide-react'
import { Thumbnail } from '@/components/thumbnail'
import { useAuth } from '@/components/auth-provider'
import { rememberGalleryPosition, useGalleryPosition } from '@/components/gallery-position'
import { useBoxSelection } from './use-box-selection'
import { type Face, type Person, personLabel } from './types'

export function FaceImage({
  faceId,
  hasCrop = true,
  thumbnailPath,
  className = 'w-12 h-12',
}: {
  faceId: number | null
  hasCrop?: boolean
  thumbnailPath?: string | null
  className?: string
}) {
  const crop = faceId && hasCrop ? `/api/faces/${faceId}/crop` : null
  const thumbnail = thumbnailPath
    ? `/api/images?path=${encodeURIComponent(thumbnailPath)}&batch=1`
    : null
  const source = crop ?? thumbnail
  return (
    <span
      className={`${className} rounded-full bg-muted inline-flex items-center justify-center shrink-0 overflow-hidden`}
    >
      {source ? (
        <Thumbnail
          src={source}
          fallbackSrc={crop ? (thumbnail ?? undefined) : undefined}
          alt=""
          className="w-full h-full object-cover"
        />
      ) : (
        <UserRound
          aria-label="Face image unavailable"
          className="w-1/2 h-1/2 text-muted-foreground"
        />
      )}
    </span>
  )
}

export function PersonCard({ person, href }: { person: Person; href: string }) {
  const { username } = useAuth()
  return (
    <Link
      href={href}
      onClick={() => rememberGalleryPosition(username, `person:${person.personId}`)}
      className="flex flex-col items-center gap-3 rounded-none border border-border/60 bg-card p-4 hover:border-primary/40 hover:bg-muted/50 transition-colors text-center"
    >
      <FaceImage faceId={person.coverFaceId} className="w-24 h-24" />
      <span className="text-sm font-medium truncate max-w-full">{personLabel(person)}</span>
      <span className="text-xs text-muted-foreground">
        {person.photoCount} photo{person.photoCount === 1 ? '' : 's'}
        {person.reviewCount > 0 && ` · ${person.reviewCount} to review`}
      </span>
    </Link>
  )
}

/** Selectable faces. Each tile links to its photo; the checkbox selects it. */
export function FaceGrid({
  faces,
  selected,
  onToggle,
  showPerson = false,
  onBoxSelect,
}: {
  faces: Face[]
  selected: Set<number>
  onToggle?: (faceId: number) => void
  showPerson?: boolean
  onBoxSelect?: (ids: number[]) => void
}) {
  const { username } = useAuth()
  const {
    root: dragRoot,
    preview: dragPreview,
    box: dragBox,
    onPointerDown,
    onClickCapture,
  } = useBoxSelection(
    faces.map((face) => face.faceId),
    selected,
    onBoxSelect,
  )
  // Returning from a photo lands back here, at the same scroll position.
  useGalleryPosition(faces.length > 0)
  return (
    <div
      ref={dragRoot}
      className={`relative ${onBoxSelect ? 'select-none pl-4 pt-4' : ''}`}
      onPointerDown={onPointerDown}
      onDragStart={onBoxSelect ? (event) => event.preventDefault() : undefined}
      onClickCapture={onClickCapture}
    >
      <ul className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-3 sm:gap-4">
        {faces.map((face) => {
          const isSelected = (dragPreview ?? selected).has(face.faceId)
          return (
            <li key={face.faceId} data-selection-id={face.faceId} className="relative">
              <Link
                href={`/photos/${face.photoId}?face=${face.faceId}`}
                onClick={() => rememberGalleryPosition(username, `photo-grid:${face.eventId}`)}
                className={`block rounded-none border border-transparent p-3 text-center hover:bg-muted transition-colors ${
                  isSelected ? 'ring-2 ring-primary bg-muted' : ''
                }`}
              >
                <FaceImage
                  faceId={face.faceId}
                  hasCrop={face.hasCrop}
                  thumbnailPath={face.thumbnailPath}
                  className="w-full max-w-20 aspect-square mx-auto"
                />
                {showPerson && (
                  <span className="block mt-1 text-xs truncate">
                    {face.personName ?? 'Unnamed'}
                  </span>
                )}
                {face.qualityOk === false && (
                  <span className="block mt-1 text-[11px] text-muted-foreground">
                    Lower detection quality
                  </span>
                )}
                {face.status === 'suggested' && (
                  <span className="block mt-1 text-[11px] text-warning dark:text-warning">
                    Needs review
                  </span>
                )}
              </Link>
              {onToggle && (
                <label className="absolute top-0 left-0 flex items-center justify-center w-11 h-11 rounded-lg cursor-pointer focus-within:ring-2 focus-within:ring-primary">
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={isSelected}
                    onChange={() => onToggle(face.faceId)}
                  />
                  <span className="w-6 h-6 rounded-full bg-background/95 border border-border flex items-center justify-center">
                    {isSelected && <Check className="w-3.5 h-3.5" aria-hidden="true" />}
                  </span>
                  <span className="sr-only">Select face {face.faceId}</span>
                </label>
              )}
            </li>
          )
        })}
      </ul>
      {dragBox && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-20 border border-primary bg-primary/15 rounded-sm"
          style={dragBox}
        />
      )}
    </div>
  )
}
