import { visibleAccountName } from '@/lib/identity/account-presentation'
import { AlbumCard } from '../album-card'
import type { EventData } from './event-grid-data'

export function LibraryIntro({
  events,
  loading = false,
  totals,
}: {
  events: EventData[]
  loading?: boolean
  totals?: { albums: number; photos: number }
}) {
  return (
    <section
      className="px-4 sm:px-8 pt-2 pb-6 mb-2 text-sm text-muted-foreground"
      aria-label="Library totals"
    >
      <span className="font-medium tabular-nums text-foreground">
        {loading ? '—' : (totals?.albums ?? events.length).toLocaleString()}
      </span>{' '}
      albums ·{' '}
      <span className="font-medium tabular-nums text-foreground">
        {loading
          ? '—'
          : (totals?.photos ?? events.reduce((n, e) => n + e.photoCount, 0)).toLocaleString()}
      </span>{' '}
      photos & videos
    </section>
  )
}
export function EventCard({ event, showOwner = true }: { event: EventData; showOwner?: boolean }) {
  return (
    <AlbumCard
      event={event}
      title={`${event.eventName} · ${event.visibility === 'GALLERY' ? 'Shared collection' : 'Private'} · Owner: ${visibleAccountName(event.ownerDisplayName || event.ownerUsername)}`}
    >
      {showOwner && (
        <p
          title={`Owner: ${visibleAccountName(event.ownerDisplayName || event.ownerUsername)}`}
          className="px-1.5 sm:px-3 py-1.5 text-[10px] sm:text-xs leading-snug text-muted-foreground break-words"
        >
          Owner: {visibleAccountName(event.ownerDisplayName || event.ownerUsername)}
        </p>
      )}
    </AlbumCard>
  )
}
