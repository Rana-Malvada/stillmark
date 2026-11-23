import { useEffect, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { usePeopleOptions } from './use-people-options'
import type { Person } from './types'

/** Picks an existing person or types a new name. */
export function PersonPicker({
  people,
  exclude = [],
  disabled,
  label,
  onPick,
}: {
  people?: Pick<Person, 'personId' | 'name'>[]
  exclude?: string[]
  disabled?: boolean
  label: string
  onPick: (target: { personId: string } | { name: string }) => void
}) {
  const [selected, setSelected] = useState('')
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const remote = usePeopleOptions(people === undefined && open, search)
  const [chosenOption, setChosenOption] = useState<Pick<Person, 'personId' | 'name'> | null>(null)
  const picker = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!picker.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const choose = (id: string) => {
    setSelected(id)
    setChosenOption(options.find((p) => p.personId === id) ?? null)
    setOpen(false)
    trigger.current?.focus()
  }

  const options = (people ?? remote.people)
    .filter((p) => p.name && !exclude.includes(p.personId))
    .sort((a, b) => a.name!.localeCompare(b.name!))
  const creating = selected === 'new'
  const existing =
    options.find((p) => p.personId === selected) ??
    (chosenOption?.personId === selected ? chosenOption : null)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (disabled) return
    if (creating) {
      const name = text.trim()
      if (!name) return
      // The loaded page is not authoritative for exact-name identity or duplicates.
      onPick({ name })
    } else {
      if (!existing) return
      onPick({ personId: existing.personId })
    }
    setSelected('')
    setText('')
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
      <div
        ref={picker}
        className="relative flex-1 sm:flex-none min-w-0 sm:w-60"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
            trigger.current?.focus()
          }
        }}
      >
        {creating ? (
          <div className="relative">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={80}
              placeholder="New person’s name"
              aria-label="New person’s name"
              autoComplete="off"
              autoFocus
              disabled={disabled}
              className="min-h-11 sm:min-h-9 w-full min-w-0 rounded border border-border bg-background pl-3 pr-9 py-1.5 text-sm"
            />
            <button
              type="button"
              aria-label="Cancel new person"
              className="absolute right-0 top-0 h-full px-2"
              disabled={disabled}
              onClick={() => {
                setSelected('')
                setText('')
              }}
            >
              <X size={16} />
            </button>
          </div>
        ) : (
          <button
            ref={trigger}
            type="button"
            aria-label={`${label}: choose a person`}
            aria-expanded={open}
            aria-haspopup="dialog"
            disabled={disabled}
            onClick={() => {
              setSearch('')
              setOpen(!open)
            }}
            className="flex items-center justify-between gap-2 min-h-11 sm:min-h-9 w-full rounded border border-border bg-background px-3 py-1.5 text-sm text-left disabled:opacity-50"
          >
            <span className="truncate">
              {creating ? 'New person…' : existing?.name || 'Choose a person…'}
            </span>
            <ChevronDown aria-hidden="true" className="w-4 h-4 shrink-0" />
          </button>
        )}
        {open && !disabled && (
          <div
            role="dialog"
            aria-label="Choose a person"
            className="person-options absolute top-full left-0 mt-1 w-full sm:w-72 max-w-[calc(100vw-3rem)] z-30 rounded-lg border border-border bg-card p-2 shadow-xl"
          >
            <input
              autoFocus
              aria-label="Search people"
              placeholder="Search names…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault()
              }}
              className="w-full min-h-10 rounded border border-border bg-background px-2 text-sm mb-1"
            />
            <div
              className="max-h-48 overflow-y-auto overscroll-contain"
              aria-label="Matching people"
            >
              {options
                .filter((p) =>
                  p.name!.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
                )
                .map((p) => (
                  <button
                    type="button"
                    key={p.personId}
                    onClick={() => choose(p.personId)}
                    className="block w-full text-left px-2 min-h-10 py-2 text-sm rounded hover:bg-muted focus-visible:bg-muted"
                  >
                    {p.name}
                  </button>
                ))}
              {(people !== undefined || (!remote.loading && !remote.error)) &&
                !options.some((p) =>
                  p.name!.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
                ) && <p className="px-2 py-3 text-xs text-muted-foreground">No matching names</p>}
            </div>
            {people === undefined && (
              <div className="text-xs px-2 py-1" aria-live="polite">
                {remote.loading && <span>Loading names…</span>}
                {remote.error && (
                  <>
                    <span role="alert">{remote.error}</span>{' '}
                    <button type="button" className="underline" onClick={remote.retry}>
                      Retry
                    </button>
                  </>
                )}
                {!remote.loading && !remote.error && remote.nextCursor && (
                  <button type="button" className="underline min-h-10" onClick={remote.more}>
                    Load more names
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setText(search.trim())
                choose('new')
              }}
              className="mt-1 border-t border-border w-full min-h-10 text-left px-2 text-xs text-primary"
            >
              + Add a new person
            </button>
          </div>
        )}
      </div>
      <button
        type="submit"
        disabled={disabled || (creating ? !text.trim() : !existing)}
        className="min-h-11 sm:min-h-9 shrink-0 rounded bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium disabled:opacity-50"
      >
        {label}
      </button>
    </form>
  )
}
