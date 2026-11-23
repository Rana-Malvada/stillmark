'use client'
import { visibleAccountName } from '@/lib/identity/account-presentation'
import type { EventData } from './gallery/event-grid-data'
import { useGalleryPosition } from './gallery-position'
import { albumGridClass } from './album-card'
import Link from 'next/link'
import { useAuth } from '@/components/auth-provider'
import { Camera, Check, ChevronRight, Plus, UserRound, X } from 'lucide-react'
import { NewAlbumButton } from './gallery/new-album-button'
import { EventCard, LibraryIntro } from './gallery/event-presentation'
import { FolderSection } from './gallery/folder-section'
import { useEventGridData } from './gallery/use-event-grid-data'
import { useEventFolderMutations } from './gallery/use-event-folder-mutations'

export function EventGrid({ mine = false }: { mine?: boolean }) {
  const { role, username, mainAdmin, canManagePersonal } = useAuth()
  const isAdmin = mainAdmin || role === 'admin_readonly' || (mine && canManagePersonal)
  const readOnly = !(mainAdmin || (mine && canManagePersonal))
  const {
    events,
    folders,
    groups,
    loading,
    restoring,
    moreBusy,
    folderError,
    setFolderError,
    setFolders,
    setRevision,
    loadMore,
  } = useEventGridData(mine, username)
  useGalleryPosition(!loading && !restoring)
  const {
    newFolderName,
    setNewFolderName,
    showNewFolder,
    setShowNewFolder,
    folderMutationBusy,
    handleCreateFolder,
    handleRenameFolder,
    handleDeleteFolder,
  } = useEventFolderMutations({
    mine,
    mainAdmin,
    username,
    folders,
    setFolders,
    setRevision,
    setFolderError,
  })

  const albumControls = (
    <div className="px-4 sm:px-8 pt-7 sm:pt-9 flex flex-wrap justify-between gap-3 items-center">
      <h1 className="page-title">{mine ? 'My Albums' : 'Collection'}</h1>
      <div className="flex flex-wrap items-center gap-2" aria-label="Album and folder actions">
        {mine && <NewAlbumButton folders={folders} />}
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            {showNewFolder ? (
              <div className="flex items-center gap-2">
                <input
                  aria-label="New folder name"
                  value={newFolderName}
                  disabled={folderMutationBusy}
                  maxLength={255}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="Folder name"
                  className="px-3 py-1.5 text-sm bg-background border border-border rounded-lg"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreateFolder()
                  }}
                />
                <button
                  aria-label="Create folder"
                  disabled={folderMutationBusy || !newFolderName.trim()}
                  onClick={() => void handleCreateFolder()}
                  className="p-1.5 text-success hover:bg-muted rounded-lg"
                >
                  <Check className="w-4 h-4" />
                </button>
                <button
                  aria-label="Cancel new folder"
                  disabled={folderMutationBusy}
                  onClick={() => {
                    setShowNewFolder(false)
                    setNewFolderName('')
                  }}
                  className="p-1.5 text-muted-foreground hover:bg-muted rounded-lg"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                disabled={readOnly || folderMutationBusy}
                onClick={() => setShowNewFolder(true)}
                className="control flex items-center gap-2"
              >
                <Plus className="w-3.5 h-3.5" /> New Folder
              </button>
            )}
          </div>
        )}
      </div>
      {folderError && (
        <p role="alert" className="w-full text-destructive">
          {folderError}
        </p>
      )}
    </div>
  )

  if (loading) {
    return (
      <>
        {albumControls}
        <LibraryIntro events={[]} loading />
        <div className={albumGridClass + ' px-4 sm:px-8'}>
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="aspect-[4/3] bg-muted animate-pulse" />
          ))}
        </div>
      </>
    )
  }

  if (events.length === 0 && folders.length === 0 && !mine) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-muted-foreground">
        {albumControls}
        <Camera className="w-16 h-16 mb-4 opacity-40" />
        <p className="text-lg">No albums yet</p>
        <Link href="/admin/upload" className="mt-4 text-primary hover:underline">
          Upload your first album
        </Link>
      </div>
    )
  }

  const sections = mine
    ? [{ key: 'mine', title: '', items: events }]
    : [
        {
          key: 'personal',
          title: 'Personal albums',
          items: events.filter(
            (e) => !e.archivedAccount && e.ownerUsername === username && e.visibility !== 'GALLERY',
          ),
        },
        {
          key: 'collection',
          title: 'Shared collection',
          items: events.filter((e) => !e.archivedAccount && e.visibility === 'GALLERY'),
        },
        {
          key: 'others',
          title: mainAdmin ? 'Other users’ personal albums' : 'Shared with you',
          items: events.filter(
            (e) => !e.archivedAccount && e.ownerUsername !== username && e.visibility !== 'GALLERY',
          ),
        },
        ...(mainAdmin
          ? [
              {
                key: 'deleted',
                title: 'Deleted accounts',
                items: events.filter((e) => e.archivedAccount),
              },
            ]
          : []),
      ]

  return (
    <div className="w-full min-w-0 pb-14">
      {albumControls}
      <LibraryIntro
        events={events}
        totals={{
          albums: groups.reduce((n, g) => n + g.albums, 0),
          photos: groups.reduce((n, g) => n + g.photos, 0),
        }}
      />

      {sections.map((section) => {
        if (section.key === 'deleted') {
          const accountAlbums = new Map<string, EventData[]>()
          for (const album of section.items) {
            const existing = accountAlbums.get(album.ownerUsername) || []
            existing.push(album)
            accountAlbums.set(album.ownerUsername, existing)
          }
          const moreGroup = groups.find(
            (group) =>
              group.section === 'deleted' &&
              section.items.filter((album) => album.folderId === group.folder_id).length <
                group.albums,
          )
          if (!accountAlbums.size && !moreGroup) return null
          return (
            <section
              key="deleted"
              aria-label="Deleted accounts"
              className="mx-4 sm:mx-8 mb-6 border-t border-border pt-3"
            >
              <h2 className="text-lg font-semibold mb-3">Deleted accounts</h2>
              <div className="divide-y divide-border">
                {[...accountAlbums].map(([owner, albums]) => {
                  const label = visibleAccountName(albums[0].ownerDisplayName || owner)
                  return (
                    <details key={owner} className="group/archive py-2">
                      <summary className="flex items-center gap-3 py-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                        <ChevronRight className="w-4 h-4 shrink-0 transition-transform group-open/archive:rotate-90" />
                        <UserRound className="w-5 h-5 shrink-0 text-muted-foreground" />
                        <span className="font-medium break-words min-w-0">{label}</span>
                        <span className="text-xs text-muted-foreground ml-auto shrink-0">
                          {albums.length} {albums.length === 1 ? 'album' : 'albums'} shown
                        </span>
                      </summary>
                      <div className={albumGridClass + ' pb-3'}>
                        {albums
                          .filter((album) => album.photoCount > 0)
                          .map((album) => (
                            <EventCard key={album.eventId} event={album} showOwner={false} />
                          ))}
                      </div>
                      {albums
                        .filter((album) => album.photoCount === 0)
                        .map((album) => (
                          <Link
                            key={album.eventId}
                            href={`/events/${album.eventId}`}
                            className="flex items-center gap-3 py-3 text-sm hover:text-primary"
                          >
                            <Camera className="w-5 h-5 text-muted-foreground" />
                            <span className="min-w-0 break-words">{album.eventName}</span>
                            <span className="ml-auto text-xs text-muted-foreground shrink-0">
                              Empty album
                            </span>
                          </Link>
                        ))}
                    </details>
                  )
                })}
              </div>
              {moreGroup && (
                <button
                  className="control mt-3"
                  disabled={moreBusy || restoring}
                  onClick={() =>
                    void loadMore(
                      'deleted',
                      moreGroup.folder_id,
                      section.items.filter((album) => album.folderId === moreGroup.folder_id),
                    )
                  }
                >
                  {moreBusy ? 'Loading…' : 'Load more archived albums'}
                </button>
              )}
            </section>
          )
        }
        const folderedEvents = new Map<number, EventData[]>()
        const uncategorized: EventData[] = []
        for (const e of section.items) {
          if (e.folderId && folders.some((f) => f.folderId === e.folderId)) {
            if (!folderedEvents.has(e.folderId)) folderedEvents.set(e.folderId, [])
            folderedEvents.get(e.folderId)!.push(e)
          } else uncategorized.push(e)
        }
        // Collection is for browsing populated folders. Empty folders remain in
        // My Albums for management, including folders inherited from deleted users.
        const sectionFolders = folders.filter(
          (f) =>
            groups.some(
              (g) => g.section === section.key && g.folder_id === f.folderId && g.albums > 0,
            ) ||
            (section.key === 'mine' && f.ownerUsername === username),
        )
        if (
          !section.items.length &&
          !sectionFolders.length &&
          !groups.some((g) => g.section === section.key) &&
          section.key !== 'mine'
        )
          return null
        return (
          <section key={section.key} aria-label={section.title || 'My albums'} className="mb-6">
            {!mine && (
              <div className="mx-4 sm:mx-8 mb-3 border-t border-border pt-3 flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">{section.title}</h2>
                {section.key === 'personal' && (
                  <Link href="/my-albums" className="control">
                    Manage personal albums
                  </Link>
                )}
              </div>
            )}
            {sectionFolders.map((folder) => {
              const folderEvents = folderedEvents.get(folder.folderId) || []

              return (
                <FolderSection
                  key={folder.folderId}
                  folder={folder}
                  showOwner={section.key === 'others' || section.key === 'deleted'}
                  events={folderEvents}
                  total={groups
                    .filter((g) => g.section === section.key && g.folder_id === folder.folderId)
                    .reduce((n, g) => n + g.albums, 0)}
                  onRename={handleRenameFolder}
                  onDelete={handleDeleteFolder}
                  moreBusy={moreBusy || restoring}
                  mutationBusy={folderMutationBusy}
                  onMore={() => void loadMore(section.key, folder.folderId, folderEvents)}
                />
              )
            })}
            {(uncategorized.length > 0 ||
              groups.some((g) => g.section === section.key && g.folder_id === null)) && (
              <div className="px-4 sm:px-8">
                {sectionFolders.length > 0 && (
                  <div className="text-xs text-muted-foreground uppercase tracking-wider mb-3">
                    Uncategorized
                  </div>
                )}
                <div className={albumGridClass}>
                  {uncategorized.map((e) => (
                    <EventCard key={e.eventId} event={e} />
                  ))}
                </div>
                {uncategorized.length <
                  groups
                    .filter((g) => g.section === section.key && g.folder_id === null)
                    .reduce((n, g) => n + g.albums, 0) && (
                  <button
                    className="control mt-3"
                    disabled={moreBusy || restoring}
                    onClick={() => void loadMore(section.key, null, uncategorized)}
                  >
                    {moreBusy ? 'Loading…' : 'More albums'}
                  </button>
                )}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
