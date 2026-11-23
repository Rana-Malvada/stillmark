'use client'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { SlidersHorizontal } from 'lucide-react'
import { usePhotoGridController } from './gallery/use-photo-grid-controller'
import { PhotoGridToolbar } from './gallery/photo-grid-toolbar'
import { PhotoGridTrashDialog } from './gallery/photo-grid-trash-dialog'
import { PhotoGridItems } from './gallery/photo-grid-items'

export function PhotoGrid({
  eventId,
  initialQuery = '',
  canEdit = false,
  addActions,
  albumActions,
  heading,
  description,
}: {
  eventId?: number
  initialQuery?: string
  canEdit?: boolean
  addActions?: ReactNode
  heading?: ReactNode
  description?: ReactNode
  albumActions?: ReactNode
}) {
  const grid = usePhotoGridController({ eventId, initialQuery, canEdit })
  const { canManagePersonal } = grid.context
  const { photos, loading, error, nextCursor, loadingMore, sentinel, more } = grid.gallery
  const { selecting } = grid.selection
  const { actionError, confirmTrash, message } = grid.actions
  const { panel, menuRef, triggerRef, activeFilters, togglePanel } = grid.menu
  return (
    <section ref={menuRef} className="media-workspace">
      <PhotoGridToolbar
        grid={grid}
        heading={heading}
        addActions={addActions}
        albumActions={albumActions}
      />
      <div className="media-context-meta">
        <span>{description || (loading ? 'Loading…' : `${photos.length} files`)}</span>
        <button
          type="button"
          className="media-sort"
          style={{ visibility: selecting ? 'hidden' : undefined }}
          aria-label="Filter & Sort"
          aria-expanded={panel === 'filters'}
          onClick={(e) => {
            triggerRef.current = e.currentTarget
            togglePanel('filters')
          }}
        >
          <SlidersHorizontal size={14} />
          {activeFilters ? 'Filtered' : 'Sort'}
        </button>
      </div>
      <PhotoGridTrashDialog grid={grid} />
      {actionError && !confirmTrash && (
        <p role="alert" className="text-destructive">
          {actionError}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}{' '}
          {canManagePersonal && (
            <Link href="/trash" className="underline">
              Open Trash
            </Link>
          )}
        </p>
      )}
      <PhotoGridItems grid={grid} />
      <div ref={sentinel}>
        {nextCursor && (
          <button className="control" disabled={loadingMore} onClick={() => void more()}>
            {loadingMore ? 'Loading…' : 'Load more photos'}
          </button>
        )}
      </div>
    </section>
  )
}
