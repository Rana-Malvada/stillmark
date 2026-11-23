import { type ReactNode, useRef, useState } from 'react'
import { SelectionBar } from '@/components/selection-bar'
import { useAuth } from '@/components/auth-provider'
import {
  readSelection,
  restoreSelection,
  selectionKey,
  writeSelection,
} from '@/lib/people/people-selection'

/** Native action menus stay compact and keyboard-accessible on small screens. */
export const peopleControl =
  'min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50'

export function SelectionToolbar({
  count,
  busy,
  actions,
  onClear,
  onSelectAll,
  selectAllLabel = 'Select shown',
  selectAllDisabled = false,
  selectionExtra,
  children,
  label = 'Selected faces',
  browsingSummary,
  browsingActions,
}: {
  label?: string
  browsingSummary?: ReactNode
  browsingActions?: ReactNode
  count: number
  busy: boolean
  actions: { label: string; run: () => void; disabled?: boolean }[]
  onClear: () => void
  onSelectAll: () => void
  selectAllLabel?: string
  selectAllDisabled?: boolean
  selectionExtra?: ReactNode
  children?: ReactNode
}) {
  const [selecting, setSelecting] = useState(false)
  const active = selecting || count > 0
  return (
    <SelectionBar
      label={label}
      actionsVisible={active}
      summary={
        <div className="people-selection-summary">
          {!active && browsingSummary ? (
            <div className="media-context-title">{browsingSummary}</div>
          ) : (
            <span role="status" className="tabular-nums text-sm font-medium">
              {active
                ? `${count.toLocaleString()} selected`
                : label === 'Selected groups'
                  ? 'Groups'
                  : 'Faces'}
            </span>
          )}
          <button
            type="button"
            disabled={busy}
            className="control"
            aria-label={active ? 'Done selecting' : 'Select faces'}
            onClick={() => {
              if (active) onClear()
              setSelecting(!active)
            }}
          >
            {active ? 'Done' : 'Select'}
          </button>
          {!active && browsingActions}
        </div>
      }
    >
      <div className="people-selection-tools">
        {active && (
          <button
            type="button"
            disabled={busy || selectAllDisabled}
            onClick={onSelectAll}
            aria-label={selectAllLabel}
            className="control"
          >
            <span aria-hidden="true">Select shown</span>
          </button>
        )}
        <button type="button" disabled={busy || count === 0} onClick={onClear} className="control">
          Clear
        </button>
        {selectionExtra}
        {children && <div className="people-selection-person">{children}</div>}
        <div className="people-selection-commands" aria-label="Selection actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={busy || count === 0 || action.disabled}
              onClick={action.run}
              className="control whitespace-nowrap"
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </SelectionBar>
  )
}

export function useSelection(scope: string) {
  const { username } = useAuth()
  const key = selectionKey(username, scope)
  type Memory = { key: string | null; selected: Set<number>; loaded: number }
  const memory = useRef<Memory>({ key: null, selected: new Set(), loaded: 0 })
  const [state, setState] = useState<Memory>(() => ({ key: null, selected: new Set(), loaded: 0 }))
  const update = (
    selected: Set<number>,
    loaded = memory.current.key === key ? memory.current.loaded : 0,
  ) => {
    memory.current = { key, selected, loaded }
    setState(memory.current)
    writeSelection(key, selected, loaded)
  }
  const selected = state.key === key ? state.selected : new Set<number>()
  return {
    key,
    selected,
    ids: [...selected],
    savedCount: () => readSelection(key).loaded,
    restore: (ids: number[]) => update(restoreSelection(readSelection(key).ids, ids), ids.length),
    rememberCount: (loaded: number) =>
      update(memory.current.key === key ? memory.current.selected : new Set(), loaded),
    toggle: (id: number) => {
      const next = new Set(memory.current.key === key ? memory.current.selected : [])
      if (!next.delete(id)) next.add(id)
      update(next)
    },
    setAll: (ids: number[]) => update(new Set(ids)),
    clear: () => update(new Set()),
  }
}
