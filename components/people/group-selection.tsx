'use client'

import { useState } from 'react'
import { Check } from 'lucide-react'
import { useBoxSelection } from './use-box-selection'
import { useChanged } from '../use-changed'
import {
  peopleApi,
  type Person,
  PersonCard,
  PersonPicker,
  SelectionToolbar,
  useChange,
} from './shared'

export function GroupSelection({
  people,
  readOnly,
  onChange,
}: {
  people: Person[]
  readOnly: boolean
  onChange: () => Promise<void>
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  if (useChanged(people)) {
    const available = new Set(people.map((p) => p.personId))
    setSelected((current) => new Set([...current].filter((id) => available.has(id))))
  }
  const reload = async () => {
    setSelected(new Set())
    await onChange()
  }
  const { run, busy, bar } = useChange(reload, onChange)
  const {
    root: dragRoot,
    preview: dragPreview,
    box: dragBox,
    onPointerDown,
    onClickCapture,
  } = useBoxSelection(
    people.map((p) => p.personId),
    selected,
    readOnly || busy ? undefined : (ids) => setSelected(new Set(ids)),
    200,
  )
  const selection = dragPreview ?? selected
  return (
    <section className="mb-10" aria-label="Unnamed groups">
      <h2 className="text-lg font-semibold mb-1">Unnamed groups</h2>
      <p className="text-sm text-muted-foreground mb-3">
        Select groups to assign to a person or ignore all their faces. Suggested matches stay in
        Review when assigned.
      </p>
      {bar}
      {!readOnly && people.length > 0 && (
        <SelectionToolbar
          label="Selected groups"
          onSelectAll={() => setSelected(new Set(people.slice(0, 200).map((p) => p.personId)))}
          selectAllLabel={people.length > 200 ? 'Select first 200 groups' : 'Select shown groups'}
          count={selected.size}
          busy={busy}
          onClear={() => setSelected(new Set())}
          actions={[
            {
              label: 'Ignore groups',
              run: () => {
                void run(`Ignored ${selected.size} groups`, () =>
                  peopleApi('/api/people/groups', 'POST', {
                    action: 'ignore',
                    groupIds: [...selected],
                  }),
                )
              },
            },
          ]}
        >
          <PersonPicker
            disabled={busy || selected.size === 0}
            label="Assign groups"
            onPick={(target) => {
              void run(`Assigned ${selected.size} groups`, () =>
                peopleApi('/api/people/groups', 'POST', {
                  action: 'assign',
                  groupIds: [...selected],
                  ...target,
                }),
              )
            }}
          />
        </SelectionToolbar>
      )}
      {!people.length ? (
        <p className="text-sm text-muted-foreground">No unnamed groups.</p>
      ) : (
        <>
          <div
            ref={dragRoot}
            className="relative select-none pl-4 pt-4"
            onPointerDown={onPointerDown}
            onDragStart={readOnly ? undefined : (event) => event.preventDefault()}
            onClickCapture={onClickCapture}
          >
            <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 sm:gap-4">
              {people.map((person) => (
                <li
                  key={person.personId}
                  data-selection-id={person.personId}
                  className={`relative rounded-none ${selection.has(person.personId) ? 'ring-2 ring-primary bg-muted' : ''}`}
                >
                  <PersonCard person={person} href={`/people/${person.personId}`} />
                  {!readOnly && (
                    <label className="absolute top-0 left-0 flex items-center justify-center w-11 h-11 rounded-lg cursor-pointer focus-within:ring-2 focus-within:ring-primary">
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={selection.has(person.personId)}
                        disabled={busy || (!selected.has(person.personId) && selected.size >= 200)}
                        onChange={() =>
                          setSelected((current) => {
                            const next = new Set(current)
                            if (!next.delete(person.personId) && next.size < 200)
                              next.add(person.personId)
                            return next
                          })
                        }
                      />
                      <span className="w-6 h-6 rounded-full bg-background/95 border border-border flex items-center justify-center">
                        {selection.has(person.personId) && (
                          <Check className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                      </span>
                      <span className="sr-only">Select group with {person.photoCount} photos</span>
                    </label>
                  )}
                </li>
              ))}
            </ul>
            {dragBox && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute z-20 border border-primary bg-primary/15 rounded-sm"
                style={dragBox}
              />
            )}
          </div>
        </>
      )}
    </section>
  )
}
