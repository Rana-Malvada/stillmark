import type { ReactNode } from 'react'
import Link from 'next/link'
import { Ellipsis, Play, Plus, SlidersHorizontal } from 'lucide-react'
import { SelectionBar } from '../selection-bar'
import { AlbumPublicLinks } from '../album-public-links'
import { PhotoGridFilters } from './photo-grid-filters'
import type { PhotoGridController } from './use-photo-grid-controller'

/** Selection commands and album menus share the controller's current capabilities. */
export function PhotoGridToolbar({
  grid,
  heading,
  addActions,
  albumActions,
}: {
  grid: PhotoGridController
  heading?: ReactNode
  addActions?: ReactNode
  albumActions?: ReactNode
}) {
  const { eventId, role, canEdit, canManagePersonal } = grid.context
  const { photos, loading, query } = grid.gallery
  const {
    selected,
    setSelected,
    selecting,
    setSelecting,
    editable,
    showMutationActions,
    mixedReadOnlySelection,
    toggleSelection,
  } = grid.selection
  const { busy, actionError, setActionError, confirmTrash, setConfirmTrash, act } = grid.actions
  const {
    albums,
    destination,
    setDestination,
    albumCursor,
    loadingAlbums,
    albumsLoaded,
    albumError,
    loadDestinationAlbums,
    albumRequestCursor,
  } = grid.destinations
  const { panel, setPanel, triggerRef, togglePanel } = grid.menu
  const control = 'control disabled:opacity-50'
  return (
    <SelectionBar
      label="Selected photos"
      actionsVisible={selecting}
      auxiliaryPanel={
        <>
          <PhotoGridFilters grid={grid} />
          <div id="album-add-panel" hidden={panel !== 'add'} className="selection-actions-panel">
            {addActions}
          </div>
          <div
            id="album-more-panel"
            hidden={panel !== 'more'}
            className="selection-actions-panel album-more-dropdown"
          >
            <button className="album-menu-item" onClick={() => setPanel('filters')}>
              <SlidersHorizontal size={18} /> Filter &amp; Sort
            </button>
            {albumActions}
            {!!eventId && !!photos.length && (
              <Link className="album-menu-item" href={`/events/${eventId}/slideshow?${query}`}>
                <Play size={18} /> Slideshow
              </Link>
            )}
          </div>
        </>
      }
      summary={
        <div className="selection-summary-row">
          {selecting ? (
            <span role="status" className="selection-count text-sm tabular-nums">
              {selected.length} selected
            </span>
          ) : (
            <div className="media-context-title">
              {heading || <h1>{eventId ? 'Album' : 'Favorites'}</h1>}
            </div>
          )}
          {!selecting && !!eventId && (canEdit || role === 'admin_readonly') && (
            <button
              disabled={!canEdit}
              aria-expanded={panel === 'add'}
              aria-controls="album-add-panel"
              className="primary-button compact-add"
              aria-label="Add"
              onClick={(e) => {
                triggerRef.current = e.currentTarget
                togglePanel('add')
              }}
            >
              <Plus size={18} />
              <span>Add</span>
            </button>
          )}
          <button
            disabled={busy || loading}
            className={`${control} selection-mode-button`}
            onClick={toggleSelection}
            aria-pressed={selecting}
            aria-label={selecting ? 'Done selecting' : 'Select photos'}
          >
            {selecting ? 'Done' : 'Select'}
          </button>
          {!selecting && !!eventId && (
            <button
              type="button"
              className={`${control} media-more`}
              aria-label={eventId ? 'More' : 'Photo options'}
              aria-expanded={!!panel && panel !== 'add'}
              aria-controls={eventId ? 'album-more-panel' : 'album-filter-panel'}
              onClick={(e) => {
                triggerRef.current = e.currentTarget
                togglePanel(eventId ? 'more' : 'filters')
              }}
            >
              {eventId ? <Ellipsis size={20} /> : <SlidersHorizontal size={18} />}
            </button>
          )}
        </div>
      }
    >
      {mixedReadOnlySelection && (
        <p role="status" className="text-sm">
          Selection includes read-only photos. Select only editable photos to change them.
        </p>
      )}
      <div className="selection-photo-commands">
        <button
          disabled={busy || loading}
          className={control}
          onClick={() => {
            setSelecting(true)
            setSelected(photos.slice(0, 200).map((p) => p.photoId))
            setConfirmTrash(false)
          }}
        >
          {photos.length > 200 ? 'Select first 200' : 'Select all shown'}
        </button>
        <button
          disabled={busy || !selected.length}
          className={control}
          onClick={() => {
            setSelected([])
            setConfirmTrash(false)
          }}
        >
          Clear
        </button>
        <button
          disabled={busy || !editable || !selected.length}
          className={control}
          onClick={() => act('favorite')}
        >
          Favorite
        </button>
        <button
          disabled={busy || !editable || !selected.length}
          className={control}
          onClick={() => act('unfavorite')}
        >
          Unfavorite
        </button>
        <a
          className={`${control} ${busy || !selected.length ? 'opacity-50' : ''}`}
          aria-disabled={busy || !selected.length}
          href={
            !busy && selected.length ? `/api/photos/download?ids=${selected.join(',')}` : undefined
          }
          target="_blank"
          rel="noopener noreferrer"
        >
          Download ZIP
        </a>
        {showMutationActions && (
          <button
            disabled={busy || !editable || !selected.length}
            className={control}
            onClick={() => {
              setActionError('')
              setConfirmTrash(true)
            }}
          >
            Move to Trash
          </button>
        )}

        {showMutationActions && (
          <details
            className="selection-popover"
            onToggle={(event) => {
              if (event.currentTarget.open && canManagePersonal && !albumsLoaded && !loadingAlbums)
                void loadDestinationAlbums(null)
            }}
          >
            <summary className={control}>Move to album</summary>
            <div className="selection-popover-content">
              {loadingAlbums && <p role="status">Loading albums…</p>}
              {albumError && (
                <div>
                  <p role="alert">{albumError}</p>
                  <button
                    className={control}
                    disabled={loadingAlbums}
                    onClick={() => loadDestinationAlbums(albumRequestCursor.current)}
                  >
                    Retry albums
                  </button>
                </div>
              )}
              <label className="text-sm">
                Destination album
                <select
                  aria-label="Destination album"
                  disabled={busy || !editable || !selected.length}
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  className="control mt-2 w-full"
                >
                  <option value="">Choose album…</option>
                  {albums
                    .filter((a) => a.eventId !== eventId)
                    .map((a) => (
                      <option key={a.eventId} value={a.eventId}>
                        {a.eventName}
                      </option>
                    ))}
                </select>
              </label>
              {albumCursor && (
                <button
                  className={control}
                  disabled={loadingAlbums}
                  onClick={() => loadDestinationAlbums(albumCursor)}
                >
                  {loadingAlbums ? 'Loading albums…' : 'Load more albums'}
                </button>
              )}
              <button
                disabled={busy || !editable || !selected.length || !destination}
                className={control}
                onClick={() => act('move')}
              >
                Move
              </button>
            </div>
          </details>
        )}
        {eventId && editable && (
          <AlbumPublicLinks
            eventId={eventId}
            canEdit={editable}
            photoIds={selected}
            className={control}
          />
        )}
      </div>
      {actionError && !confirmTrash && (
        <p role="alert" className="selection-feedback text-destructive">
          {actionError}
        </p>
      )}
    </SelectionBar>
  )
}
