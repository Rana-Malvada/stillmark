import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Ellipsis, Search } from 'lucide-react'
import { usePeopleOptions } from './use-people-options'
import { FaceImage, peopleApi, peopleControl, type Person, type useChange } from './shared'

/** Keep menu state at the route lifetime, including when selection temporarily hides its view. */
export function usePersonActions() {
  const [name, setName] = useState('')
  const [editing, setEditing] = useState(false)
  const [merging, setMerging] = useState(false)
  const [personMenuOpen, setPersonMenuOpen] = useState(false)
  const personMenu = useRef<HTMLDivElement>(null)
  const personMenuTrigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (personMenuOpen && (editing || merging))
      personMenu.current?.querySelector('input')?.focus({ preventScroll: true })
  }, [personMenuOpen, editing, merging])
  useEffect(() => {
    if (!personMenuOpen) return
    const outside = (event: Event) => {
      if (!personMenu.current?.contains(event.target as Node)) setPersonMenuOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
    }
  }, [personMenuOpen])
  return {
    name,
    setName,
    editing,
    setEditing,
    merging,
    setMerging,
    personMenuOpen,
    setPersonMenuOpen,
    personMenu,
    personMenuTrigger,
  }
}

/** Person-level edits own their menu/focus state; the route owns correction recovery and navigation. */
export function PersonActions({
  personId,
  person,
  readOnly,
  busy,
  run,
  mergeFrom,
  menu,
}: {
  menu: ReturnType<typeof usePersonActions>
  personId: string
  person: Person
  readOnly: boolean
  busy: boolean
  run: ReturnType<typeof useChange>['run']
  mergeFrom: (target: { personId: string } | { name: string }) => void
}) {
  const {
    name,
    setName,
    editing,
    setEditing,
    merging,
    setMerging,
    personMenuOpen,
    setPersonMenuOpen,
    personMenu,
    personMenuTrigger,
  } = menu
  const button = peopleControl
  const rename = (e: React.FormEvent) => {
    e.preventDefault()
    const next = name.trim()
    if (next === (person.name ?? '')) return
    void run(next ? `Named ${next}` : 'Name removed', () =>
      peopleApi(`/api/people/${personId}`, 'PATCH', { name: next || null }),
    )
  }
  return (
    <>
      {!readOnly && (
        <div
          ref={personMenu}
          className="person-actions"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && personMenuOpen) {
              event.preventDefault()
              event.stopPropagation()
              setPersonMenuOpen(false)
              personMenuTrigger.current?.focus({ preventScroll: true })
            }
          }}
        >
          <button
            ref={personMenuTrigger}
            type="button"
            className="control person-more inline-flex items-center gap-2"
            aria-label="Person actions"
            aria-expanded={personMenuOpen}
            aria-controls="person-actions-panel"
            onClick={() => {
              setPersonMenuOpen(!personMenuOpen)
              setEditing(false)
              setMerging(false)
            }}
          >
            <Ellipsis size={20} aria-hidden="true" /> <span className="sr-only">More</span>
          </button>
          <div id="person-actions-panel" hidden={!personMenuOpen} className="person-actions-panel">
            {editing ? (
              <form onSubmit={rename} className="grid gap-3">
                <label className="text-sm font-medium">
                  Name
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={80}
                    aria-label="Name"
                    className="control mt-2 w-full min-w-0"
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={busy || name.trim() === (person.name ?? '')}
                    className={button}
                  >
                    Save name
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={button}
                    onClick={() => {
                      setName(person.name ?? '')
                      setEditing(false)
                      personMenuTrigger.current?.focus({ preventScroll: true })
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : merging ? (
              <MergePicker
                exclude={personId}
                disabled={busy}
                onClose={() => {
                  setMerging(false)
                  personMenuTrigger.current?.focus({ preventScroll: true })
                }}
                onPick={(id) => mergeFrom({ personId: id })}
              />
            ) : (
              <div className="person-action-list">
                {person.name && !person.hidden && (
                  <Link
                    href={`/search?person=${personId}`}
                    className="control inline-flex items-center gap-2"
                  >
                    <Search size={16} aria-hidden="true" /> See photos
                  </Link>
                )}

                <button disabled={busy} onClick={() => setEditing(true)}>
                  {person.name ? 'Edit name' : 'Add a name'}
                </button>
                <button disabled={busy} onClick={() => setMerging(true)}>
                  Merge with another person
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(person.hidden ? 'Person shown' : 'Person hidden', () =>
                      peopleApi(`/api/people/${personId}`, 'PATCH', { hidden: !person.hidden }),
                    )
                  }
                >
                  {person.hidden ? 'Show person' : 'Hide person'}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run('Ignored all faces in this group', () =>
                      peopleApi(`/api/people/${personId}/ignore`, 'POST', {}),
                    )
                  }
                >
                  Ignore all faces in this group
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/** Merge choices are named, visible people only. */
function MergePicker({
  exclude,
  disabled,
  onPick,
  onClose,
}: {
  exclude: string
  disabled: boolean
  onPick: (personId: string) => void
  onClose: () => void
}) {
  const [filter, setFilter] = useState('')
  const options = usePeopleOptions(true, filter, true)
  const shown = options.people.filter((p) => p.personId !== exclude)
  return (
    <section aria-label="Merge with someone" className="min-w-0">
      <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
        <span className="font-medium">Choose who is the same person</span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name"
          aria-label="Filter by name"
          className="min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-base w-full sm:w-64"
        />
        <button type="button" className={`${peopleControl} ml-auto`} onClick={onClose}>
          Cancel
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {options.loading ? 'Loading name choices…' : 'No named people match your search.'}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 max-h-80 overflow-y-auto">
          {shown.map((p) => (
            <li key={p.personId}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(p.personId)}
                className="w-full flex flex-col items-center gap-1 rounded-none p-2 hover:bg-muted disabled:opacity-50"
              >
                <FaceImage faceId={p.coverFaceId ?? null} className="w-16 h-16" />
                <span className="text-sm font-medium break-words max-w-full">{p.name}</span>
                <span className="text-[11px] text-muted-foreground">
                  {p.photoCount} photo{p.photoCount === 1 ? '' : 's'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {options.error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {options.error}{' '}
          <button type="button" className="underline" onClick={options.retry}>
            Retry names
          </button>
        </p>
      )}
      {options.nextCursor && (
        <button
          type="button"
          className={`${peopleControl} mt-3`}
          disabled={options.loading}
          onClick={options.more}
        >
          {options.loading ? 'Loading…' : 'Load more names'}
        </button>
      )}
    </section>
  )
}
