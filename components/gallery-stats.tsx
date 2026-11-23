'use client'
import { useEffect, useRef, useState } from 'react'
import { BarChart3, RefreshCw } from 'lucide-react'
import { useGalleryStatus } from '@/components/use-gallery-status'

/** Header owns navigation; this feature owns its on-demand statistics and actions. */
export function GalleryStats({ canManage }: { canManage: boolean }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    // Safari does not focus a button on pointer activation. Escape must also
    // close the popup when focus remains on the page behind it.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      button.current?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  return (
    <div className="static sm:relative" ref={root}>
      <button
        ref={button}
        aria-label="Gallery status"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="nav-tool sm:px-2"
      >
        <BarChart3 className="w-4 h-4" />
        <span className="hidden sm:inline">Stats</span>
      </button>
      {open && <GalleryStatsContent canManage={canManage} />}
    </div>
  )
}

function GalleryStatsContent({ canManage }: { canManage: boolean }) {
  const { stats, loading, error, mutating, refresh, mutate } = useGalleryStatus(canManage)
  return (
    <div
      role="region"
      aria-label="Gallery statistics"
      className="absolute inset-x-4 top-full mt-2 w-auto max-h-[70dvh] overflow-y-auto overscroll-contain bg-popover border border-border rounded-xl shadow-xl p-5 z-50 sm:left-auto sm:right-0 sm:w-64"
    >
      {error && (
        <div role="alert" className="text-xs text-destructive mb-2">
          <p>{error}</p>
          <button className="control mt-2" onClick={() => void refresh()} disabled={loading}>
            Retry status
          </button>
        </div>
      )}
      {loading && !stats ? (
        <p role="status" className="text-xs text-muted-foreground text-center">
          Loading...
        </p>
      ) : stats ? (
        <div className="space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Photos</span>
            <span className="font-medium">{stats.total_photos}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">AI Done</span>
            <span className="font-medium">{stats.photos_with_ai}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Search copy acknowledged</span>
            <span className="font-medium">{stats.in_search}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Pending search updates</span>
            <span className="font-medium text-warning">{stats.pending_sync}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span
              className="text-muted-foreground"
              title="Cleanup requests awaiting search acknowledgment, including files deleted before indexing was confirmed."
            >
              Pending search cleanup
            </span>
            <span className="font-medium text-warning">{stats.pending_search_removals ?? 0}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Pending AI</span>
            <span
              className={`font-medium ${Number(stats.photos_without_ai) > 0 ? 'text-warning' : ''}`}
            >
              {stats.photos_without_ai}
            </span>
          </div>
          {Number(stats.photos_failed) > 0 && (
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Failed</span>
              <span className="font-medium text-destructive">{stats.photos_failed}</span>
            </div>
          )}
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Videos</span>
            <span className="font-medium text-muted-foreground">{stats.total_videos}</span>
          </div>
          {stats.failed_photos.length > 0 && (
            <div className="border-t border-border pt-2 mt-2">
              <p className="text-[10px] text-destructive uppercase tracking-wider mb-1">
                Failed Photos
                {Number(stats.photos_failed) > stats.failed_photos.length &&
                  ` (showing ${stats.failed_photos.length} of ${stats.photos_failed})`}
              </p>
              {stats.failed_photos.map((f) => (
                <div key={f.photo_id} className="text-[10px] text-muted-foreground mb-1">
                  <span className="text-foreground">{f.source_filename}</span>
                  <br />
                  <span className="text-destructive">{f.ai_error}</span>
                  <button
                    disabled={!canManage || mutating}
                    className="ml-2 underline"
                    onClick={() => void mutate('/api/ai-categorize', { retryPhotoId: f.photo_id })}
                  >
                    Retry description
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="border-t border-border pt-2 mt-2">
            <button
              onClick={() => void mutate('/api/search-sync', {})}
              disabled={mutating || !canManage}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`w-3 h-3 ${mutating ? 'animate-spin' : ''}`} />
              {mutating ? 'Syncing...' : 'Sync Search'}
            </button>
          </div>
        </div>
      ) : !error ? (
        <p className="text-xs text-muted-foreground text-center">No status available.</p>
      ) : null}
    </div>
  )
}
