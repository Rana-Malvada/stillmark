import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { latestRequest } from '@/lib/latest-request'
import { isPersonFacePage, normalizeFacePage } from './person-detail-loader'
import {
  type Face,
  FaceGrid,
  peopleApi,
  peopleControl,
  PersonPicker,
  SelectionToolbar,
  useChange,
  useSelection,
} from './shared'

const FACE_LISTS = {
  review: {
    url: '/api/people/review',
    empty: 'Nothing to review.',
    note: 'Suggested matches are grouped by person. Select faces to confirm together, or choose Not this person. Confirmations also help match remaining unknown faces.',
  },
  unknown: {
    url: '/api/people/unknown',
    empty: 'No unknown faces.',
    note: 'Select faces to tag or ignore. Confirmed faces help identify other photos, regardless of detection quality.',
  },
  ignored: {
    url: '/api/people/unknown?ignored=1',
    empty: 'No ignored faces.',
    note: 'Ignored faces are left out of People and search.',
  },
} as const

export function FacesSection({
  kind,
  quality,
  readOnly,
  onChange,
}: {
  kind: keyof typeof FACE_LISTS
  quality: string
  readOnly: boolean
  onChange: () => Promise<void>
}) {
  const list = {
    ...FACE_LISTS[kind],
    empty:
      kind === 'unknown' && quality !== 'all'
        ? 'No unknown faces in this detection-quality filter.'
        : FACE_LISTS[kind].empty,
    url: FACE_LISTS[kind].url + (kind === 'unknown' ? `?quality=${quality}` : ''),
  }
  const [faces, setFaces] = useState<Face[] | null>(null)
  const nextCursor = useRef<string | null | undefined>(undefined)
  const [more, setMore] = useState(false)
  const selection = useSelection(`list:${kind}${kind === 'unknown' ? `:${quality}` : ''}`)
  const requests = useRef(latestRequest())
  const load = useCallback(async () => {
    const request = requests.current.begin()
    setLoadingMore(false)
    let data
    try {
      data = normalizeFacePage(
        await peopleApi(list.url, 'GET', undefined, request.signal, isPersonFacePage),
      )
    } catch (error) {
      if (!request.current()) return
      throw error
    }
    if (!request.current()) return
    setFaces(data.faces)
    nextCursor.current = data.nextCursor
    setMore(data.more)
    selection.restore(data.faces.map((face) => face.faceId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.url, selection.key])
  const [loadingMore, setLoadingMore] = useState(false)
  const reload = async () => {
    selection.clear()
    await load()
    await onChange()
  }
  const {
    run: runChange,
    busy,
    bar,
    setError,
  } = useChange(reload, async () => {
    await load()
    await onChange()
  })
  const run = (message: string, action: () => Promise<unknown>) => {
    const removed = new Set(selection.ids)
    return runChange(message, action, () => {
      // Only remove faces after the server commits. Undo still performs a full reload.
      setFaces((current) => current?.filter((face) => !removed.has(face.faceId)) ?? null)
      selection.clear()
      void onChange()
    })
  }
  const showMore = async () => {
    if (busy || loadingMore) return
    const request = requests.current.begin()
    setLoadingMore(true)
    try {
      const separator = list.url.includes('?') ? '&' : '?'
      const data = normalizeFacePage(
        await peopleApi(
          `${list.url}${separator}${nextCursor.current ? `cursor=${encodeURIComponent(nextCursor.current)}` : `offset=${faces?.length ?? 0}`}`,
          'GET',
          undefined,
          request.signal,
          isPersonFacePage,
        ),
      )
      if (!request.current()) return
      const seen = new Set((faces ?? []).map((f) => f.faceId))
      const combined = [...(faces ?? []), ...data.faces.filter((f) => !seen.has(f.faceId))]
      setFaces(combined)
      nextCursor.current = data.nextCursor
      selection.rememberCount(combined.length)
      setMore(data.more)
    } catch (e) {
      if (request.current()) setError(e instanceof Error ? e.message : 'Unable to load more faces')
    } finally {
      if (request.current()) setLoadingMore(false)
    }
  }
  useEffect(() => {
    const owner = requests.current
    void load().catch((e) => setError(e.message))
    return () => owner.cancel()
  }, [load, setError])

  const chosen = (faces ?? []).filter((f) => selection.selected.has(f.faceId))
  const count = `${chosen.length} face${chosen.length === 1 ? '' : 's'}`
  /** Review decisions apply per suggested person, so group the selection by person. */
  const byPerson = () => {
    const groups = new Map<string, number[]>()
    for (const f of chosen) groups.set(f.personId!, [...(groups.get(f.personId!) ?? []), f.faceId])
    return [...groups]
  }
  /** One request per suggested person; a single person's change keeps its Undo. */
  const eachPerson = async (decision: 'confirm' | 'reject') => {
    const groups = byPerson()
    let last: unknown
    for (const [person, ids] of groups)
      last = await peopleApi(`/api/people/${person}/faces`, 'POST', {
        action: decision,
        faceIds: ids,
      })
    return groups.length === 1 ? last : undefined
  }

  return (
    <section aria-label={kind}>
      {kind !== 'unknown' && <p className="text-xs text-muted-foreground mb-3">{list.note}</p>}
      {bar}
      {!readOnly && faces !== null && faces.length > 0 && (
        <SelectionToolbar
          onSelectAll={() => selection.setAll((faces ?? []).map((face) => face.faceId))}
          selectAllDisabled={chosen.length === faces?.length}
          count={chosen.length}
          busy={busy || loadingMore}
          onClear={selection.clear}
          actions={[
            ...(kind === 'review'
              ? [
                  {
                    label: 'Confirm matches',
                    run: () => {
                      void run(`Confirmed ${count}`, () => eachPerson('confirm'))
                    },
                  },
                  {
                    label: 'Not this person',
                    run: () => {
                      void run(`Removed ${count}`, () => eachPerson('reject'))
                    },
                  },
                ]
              : []),
            {
              label: kind === 'ignored' ? 'Restore faces' : 'Ignore faces',
              run: () => {
                void run(`${kind === 'ignored' ? 'Restored' : 'Ignored'} ${count}`, () =>
                  peopleApi('/api/people/ignore', 'POST', {
                    faceIds: selection.ids,
                    ignored: kind !== 'ignored',
                  }),
                )
              },
            },
          ]}
        >
          {kind !== 'ignored' && (
            <PersonPicker
              disabled={busy || loadingMore || chosen.length === 0}
              label="Tag as"
              onPick={(target) =>
                run(`Tagged ${count}`, () =>
                  peopleApi('/api/people/assign', 'POST', { faceIds: selection.ids, ...target }),
                )
              }
            />
          )}
        </SelectionToolbar>
      )}

      {faces === null ? (
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" aria-label="Loading" />
      ) : (
        <>
          {faces.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {more ? 'All shown faces handled. Load more to continue.' : list.empty}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <span className="text-xs text-muted-foreground tabular-nums">
              {faces.length.toLocaleString()} faces shown
            </span>
            {kind === 'unknown' && !readOnly && (
              <p className="text-xs text-muted-foreground">Drag to select more · Escape cancels</p>
            )}
          </div>
          <FaceGrid
            faces={faces}
            selected={selection.selected}
            onToggle={readOnly ? undefined : selection.toggle}
            showPerson={kind === 'review'}
            onBoxSelect={kind === 'unknown' && !readOnly && !busy ? selection.setAll : undefined}
          />
          {more && (
            <button
              type="button"
              className={`${peopleControl} mt-5 mb-8 min-w-40`}
              disabled={loadingMore || busy}
              onClick={showMore}
            >
              {loadingMore ? 'Loading…' : 'More — next 200'}
            </button>
          )}
        </>
      )}
    </section>
  )
}
