'use client'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { Camera, Images } from 'lucide-react'
import { Thumbnail } from './thumbnail'
import { monthName } from '@/lib/albums/folder-parser'
import { useAuth } from './auth-provider'
import { rememberGalleryPosition } from './gallery-position'

export const albumGridClass =
  'grid grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-1.5 sm:gap-2'
interface AlbumCardData {
  eventId: number
  eventName: string
  eventMonth: number | null
  eventYear: number | null
  location: string | null
  photoCount: number
  coverUrl: string | null
}
export function AlbumCard({
  event,
  title,
  prefetch,
  children,
}: {
  event: AlbumCardData
  title?: string
  prefetch?: boolean
  children?: ReactNode
}) {
  const { username } = useAuth()
  const date = [event.eventMonth ? monthName(event.eventMonth) : '', event.eventYear ?? '']
    .filter(Boolean)
    .join(' ')
  const details = [date, event.location].filter(Boolean).join(' · ')
  return (
    <Link
      onClick={() => rememberGalleryPosition(username, `album:${event.eventId}`)}
      href={`/events/${event.eventId}`}
      className="gallery-card group"
      title={title}
      prefetch={prefetch}
    >
      <div className="relative aspect-square overflow-hidden bg-muted">
        <div className="absolute inset-0 flex items-center justify-center">
          <Camera className="w-10 h-10 text-muted-foreground/35" />
        </div>
        {event.coverUrl && (
          <Thumbnail
            src={event.coverUrl}
            alt={event.eventName}
            className="relative w-full h-full object-cover"
          />
        )}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'linear-gradient(to bottom, color-mix(in srgb, var(--scrim) 20%, transparent) 0%, transparent 30%, color-mix(in srgb, var(--scrim) 35%, transparent) 55%, color-mix(in srgb, var(--scrim) 90%, transparent) 100%)',
          }}
        />
        <span className="absolute top-1 right-1 sm:top-2 sm:right-2 inline-flex items-center gap-1.5 rounded-full bg-scrim/55 backdrop-blur-md px-1.5 sm:px-2.5 py-0.5 sm:py-1 text-[10px] font-medium tracking-wide text-on-image">
          <Images className="w-3 h-3" />
          {event.photoCount}
        </span>
        <div className="absolute inset-x-0 bottom-0 p-1.5 sm:p-3 text-on-image">
          <h2
            title={event.eventName}
            className="text-[11px] sm:text-sm font-semibold leading-snug line-clamp-2 drop-shadow-sm"
          >
            {event.eventName}
          </h2>
          {details && (
            <p title={details} className="mt-1 text-[10px] sm:text-xs text-on-image/85 truncate">
              {details}
            </p>
          )}
        </div>
      </div>
      {children}
    </Link>
  )
}
