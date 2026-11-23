import type { PhotoGridController } from './use-photo-grid-controller'

/** Controlled filters retain canonical URL updates in the grid controller. */
export function PhotoGridFilters({
  grid,
}: {
  grid: Pick<PhotoGridController, 'context' | 'gallery' | 'actions' | 'menu'>
}) {
  const { eventId } = grid.context
  const { query, photos, loading, applyQuery } = grid.gallery
  const { busy, setMessage } = grid.actions
  const { panel, setPanel } = grid.menu
  const control = 'control disabled:opacity-50'
  return (
    <form
      id="album-filter-panel"
      hidden={panel !== 'filters'}
      className="selection-actions-panel gallery-filter-panel"
      onSubmit={(e) => {
        e.preventDefault()
        const data = new FormData(e.currentTarget)
        const p = new URLSearchParams()
        for (const [k, v] of data) if (v) p.set(k, String(v))
        applyQuery(p.toString())
        setMessage('')
        setPanel(null)
      }}
    >
      <fieldset disabled={busy} className="gallery-filter-fields">
        <label className="text-xs">
          Sort
          <select
            key={`sort:${query}`}
            defaultValue={new URLSearchParams(query).get('sort') || 'oldest'}
            name="sort"
            className={`block ${control}`}
          >
            <option value="oldest">Date: oldest first</option>
            <option value="newest">Date: newest first</option>
            <option value="name">Filename</option>
            <option value="uploaded">Recently uploaded</option>
          </select>
        </label>
        <label className="text-xs">
          Media
          <select
            key={`media:${query}`}
            defaultValue={new URLSearchParams(query).get('media') || ''}
            name="media"
            className={`block ${control}`}
          >
            <option value="">Photos and videos</option>
            <option value="photo">Photos only</option>
            <option value="video">Videos only</option>
          </select>
        </label>
        {eventId && (
          <label className="text-sm p-2">
            <input
              key={`favorite:${query}`}
              defaultChecked={new URLSearchParams(query).get('favorite') === 'true'}
              type="checkbox"
              name="favorite"
              value="true"
            />{' '}
            Favorites only
          </label>
        )}
        <button className={control}>Apply</button>
        <button
          type="reset"
          className={control}
          onClick={() => {
            applyQuery('')
            setMessage('')
            setPanel(null)
          }}
        >
          Reset
        </button>
      </fieldset>
      {eventId && (
        <p className="mt-3 text-xs text-muted-foreground">
          {loading ? 'Loading…' : `${photos.length} files shown`}
        </p>
      )}
    </form>
  )
}
