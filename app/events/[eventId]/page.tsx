import { galleryQueryString } from '@/lib/gallery-query'
import { accountDisplayName } from '@/lib/identity/account-display-name'
import { AlbumBack } from '@/components/gallery-position'
import { AlbumPublicLinks } from '@/components/album-public-links'
import { AlbumDate } from '@/components/album-date'
import { AlbumLocation } from '@/components/album-location'
import { HttpError } from '@/lib/http'
import { requireAlbumAccess } from '@/lib/albums/album-access'
import { AlbumSharing } from '@/components/album-sharing'
import { getEvent } from '@/lib/albums/events'
import { PhotoGrid } from '@/components/photo-grid'
import { AddPhotosButton } from '@/components/add-photos-button'
import { EventActions } from '@/components/event-actions'
import { monthName } from '@/lib/albums/folder-parser'
import { notFound } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function EventPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { eventId } = await params
  const id = Number(eventId)
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) notFound()
  const access = await requireAlbumAccess(id).catch((e) => {
    if (e instanceof HttpError && e.status === 404) notFound()
    throw e
  })
  const event = await getEvent(id)
  if (!event) notFound()
  const ownerLabel = access.caller.mainAdmin ? await accountDisplayName(event.ownerUsername) : null

  return (
    <main className="w-full min-w-0 mx-auto">
      <PhotoGrid
        initialQuery={galleryQueryString(await searchParams)}
        heading={
          <>
            <AlbumBack eventId={event.eventId} />
            <h1 title={event.eventName}>{event.eventName}</h1>
          </>
        }
        description={
          <>
            {event.location && `${event.location} · `}
            {event.eventMonth ? monthName(event.eventMonth) : ''} {event.eventYear ?? ''} ·{' '}
            {event.photoCount} photos
          </>
        }
        canEdit={access.canEdit}
        eventId={event.eventId}
        addActions={
          <AddPhotosButton
            folderId={event.folderId}
            canEdit={access.canEdit}
            eventId={event.eventId}
            sourceFolder={event.eventName}
          />
        }
        albumActions={
          <>
            <div className="px-3 py-2 border-b mb-1">
              <p className="font-semibold whitespace-normal">{event.eventName}</p>
              {ownerLabel && <p className="text-xs text-muted-foreground">Owner: {ownerLabel}</p>}
            </div>
            <AlbumPublicLinks
              eventId={event.eventId}
              canEdit={access.canEdit && access.caller.role !== 'admin_readonly'}
            />
            <EventActions
              canEdit={access.canEdit}
              eventId={event.eventId}
              eventName={event.eventName}
              location={event.location}
              sortOrder={event.sortOrder}
              eventMonth={event.eventMonth}
              eventYear={event.eventYear}
              folderId={event.folderId}
            />
            <AlbumLocation
              eventId={event.eventId}
              canEdit={access.canEdit && access.caller.role !== 'admin_readonly'}
            />
            <AlbumDate
              eventId={event.eventId}
              canEdit={access.canEdit && access.caller.role !== 'admin_readonly'}
            />
            <AlbumSharing eventId={event.eventId} canEdit={access.canEdit} />
          </>
        }
      />
    </main>
  )
}
