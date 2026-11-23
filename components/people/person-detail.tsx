'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { PersonActions, usePersonActions } from './person-actions'
import { photoReturnPath } from '@/lib/photos/photo-return'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Loader2, Search } from 'lucide-react'
import { galleryParent, rememberGalleryParent } from '@/components/gallery-position'
import { useAuth } from '@/components/auth-provider'
import { ClientResponseError } from '@/lib/client-response'
import {
  loadPersonDetail,
  loadPersonFacePage,
  type PersonDetailResult,
} from './person-detail-loader'
import {
  type Face,
  FaceGrid,
  FaceImage,
  peopleApi,
  peopleControl,
  personLabel,
  PersonPicker,
  SelectionToolbar,
  useChange,
  useSelection,
} from './shared'

export function PersonDetail({
  personId,
  returnTo = null,
}: {
  personId: string
  returnTo?: string | null
}) {
  const router = useRouter()
  const { username, canManagePersonal } = useAuth()
  const readOnly = !canManagePersonal
  const photoReturn = photoReturnPath(returnTo)
  const backLabel = photoReturn ? 'Back to photo' : 'Back to People'
  const backToPeople = () =>
    router.push(photoReturn ?? galleryParent(username, `person:${personId}`, '/people'), {
      scroll: false,
    })
  const [detail, setDetail] = useState<{ personId: string; result: PersonDetailResult } | null>(
    null,
  )
  const result = detail?.personId === personId ? detail.result : null
  const person = result?.status === 'ready' ? result.person : null
  const [faces, setFaces] = useState<Face[]>([])
  const [more, setMore] = useState(false)
  const nextCursor = useRef<string | null | undefined>(undefined)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState('')
  const loadedCount = useRef(200)
  const loadGeneration = useRef(0)
  const loadController = useRef<AbortController | null>(null)
  const loadingPage = useRef(false)
  const actionMenu = usePersonActions()
  const { setName, setEditing, setMerging, setPersonMenuOpen } = actionMenu
  const selection = useSelection(`person:${personId}`)
  const mergeDestination = useRef<string | null>(null)

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    loadController.current?.abort()
    const controller = new AbortController()
    loadController.current = controller
    loadingPage.current = false
    setLoadingMore(false)
    setLoadError('')
    setDetail(null)
    setFaces([])
    setMore(false)
    nextCursor.current = undefined
    try {
      // Keep the reviewed range visible after removing a match or undoing a correction.
      const data = await loadPersonDetail(personId, loadedCount.current, controller.signal)
      if (controller.signal.aborted || generation !== loadGeneration.current) return
      setDetail({ personId, result: data })
      if (data.status !== 'ready') return
      setName(data.person.name ?? '')
      setFaces(data.faces)
      setMore(data.more)
      nextCursor.current = data.nextCursor
      selection.restore(data.faces.map((face) => face.faceId))
      setEditing(false)
      setMerging(false)
      setPersonMenuOpen(false)
    } catch (error) {
      if (!controller.signal.aborted && generation === loadGeneration.current)
        setDetail({
          personId,
          result: {
            status: 'error',
            message:
              error instanceof Error ? error.message : 'Could not load this person. Try again.',
          },
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId, selection.key])
  const { run, busy, bar } = useChange(async () => {
    selection.clear()
    const destination = mergeDestination.current
    mergeDestination.current = null
    if (destination && destination !== personId) {
      rememberGalleryParent(
        username,
        `person:${destination}`,
        galleryParent(username, `person:${personId}`, '/people'),
      )
      router.replace(
        `/people/${destination}${photoReturn ? `?returnTo=${encodeURIComponent(photoReturn)}` : ''}`,
      )
    } else await load()
  }, load)
  useEffect(() => {
    loadedCount.current = 200
    mergeDestination.current = null
    setEditing(false)
    setMerging(false)
    void load()
    return () => {
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- a generation counter, not a DOM node: cleanup must bump the live value to fence late pages
      loadGeneration.current++
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- holds the newest request: cleanup must abort the live one
      loadController.current?.abort()
    }
  }, [load, setEditing, setMerging])

  async function loadMore(all = false) {
    if (loadingPage.current || busy || !more) return
    loadingPage.current = true
    setLoadingMore(true)
    setLoadError('')
    const generation = loadGeneration.current
    let accumulated = faces
    try {
      for (;;) {
        const next = await loadPersonFacePage(
          personId,
          accumulated.length,
          nextCursor.current,
          loadController.current?.signal,
        )
        if (generation !== loadGeneration.current) return
        const seen = new Set(accumulated.map((face) => face.faceId))
        const added = next.faces.filter((face) => !seen.has(face.faceId))
        accumulated = [...accumulated, ...added]
        nextCursor.current = next.nextCursor
        loadedCount.current = accumulated.length
        setFaces(accumulated)
        setMore(next.more && added.length > 0)
        if (!all || !next.more || added.length === 0) break
      }
    } catch (error) {
      if (generation === loadGeneration.current) {
        if (error instanceof ClientResponseError && [401, 403, 404].includes(error.status)) {
          setDetail({
            personId,
            result:
              error.status === 404
                ? { status: 'missing' }
                : { status: 'error', message: error.message },
          })
          setFaces([])
          setMore(false)
        }
        setLoadError(
          error instanceof Error ? error.message : 'Could not load more faces. Try again.',
        )
      }
    } finally {
      if (generation === loadGeneration.current) {
        loadingPage.current = false
        setLoadingMore(false)
      }
    }
  }

  if (result?.status === 'missing')
    return (
      <div className="px-5 sm:px-8 text-sm">
        <p className="mb-3">This person was merged, removed, or is not visible to you.</p>
        <button onClick={backToPeople} className="underline">
          {backLabel}
        </button>
      </div>
    )
  if (!person)
    return (
      <div className="person-detail px-4 sm:px-8">
        <button
          type="button"
          onClick={backToPeople}
          className="control inline-flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> {backLabel}
        </button>
        {result?.status === 'error' ? (
          <div role="alert" className="py-8 space-y-3 text-sm">
            <p>{result.message}</p>
            <button type="button" className={peopleControl} onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" aria-label="Loading" />
          </div>
        )}
      </div>
    )

  const chosen = selection.ids
  const count = `${chosen.length} face${chosen.length === 1 ? '' : 's'}`
  const suggested = faces.filter((f) => f.status === 'suggested').map((f) => f.faceId)
  const faceAction = (
    action: 'confirm' | 'reject' | 'split' | 'move',
    message: string,
    extra = {},
  ) =>
    run(message, () =>
      peopleApi(`/api/people/${personId}/faces`, 'POST', { action, faceIds: chosen, ...extra }),
    )
  const button = peopleControl

  const mergeFrom = (target: { personId: string } | { name: string }) => {
    if (!('personId' in target)) return
    void run('People merged', async () => {
      const result = await peopleApi<{ personId: string; correctionId?: number }>(
        '/api/people/merge',
        'POST',
        { keep: target.personId, absorb: [personId] },
      )
      mergeDestination.current = result.personId
      return result
    })
  }

  const heading = (
    <>
      <button
        type="button"
        onClick={backToPeople}
        aria-label={backLabel}
        className="control person-back"
      >
        <ArrowLeft className="w-4 h-4" aria-hidden="true" />{' '}
        <span className="sr-only">{backLabel}</span>
      </button>

      <div className="person-detail-heading">
        <FaceImage
          faceId={person.coverFaceId}
          className="person-avatar w-10 h-10 sm:w-12 sm:h-12"
        />
        <div className="min-w-0">
          <h1 className="page-title break-words">{personLabel(person)}</h1>
        </div>
      </div>
    </>
  )
  const personActions = (
    <PersonActions
      menu={actionMenu}
      personId={personId}
      person={person}
      readOnly={readOnly}
      busy={busy}
      run={run}
      mergeFrom={mergeFrom}
    />
  )

  return (
    <div className="person-detail">
      {bar}

      {!readOnly && (
        <SelectionToolbar
          browsingSummary={heading}
          browsingActions={personActions}
          onSelectAll={() => selection.setAll(faces.map((face) => face.faceId))}
          selectAllLabel="Select all on this page"
          selectAllDisabled={loadingMore || chosen.length === faces.length}
          selectionExtra={
            suggested.length > 0 ? (
              <button
                type="button"
                className={button}
                disabled={busy || loadingMore}
                onClick={() => selection.setAll(suggested)}
              >
                Select the {suggested.length} to review
              </button>
            ) : undefined
          }
          count={chosen.length}
          busy={busy}
          onClear={selection.clear}
          actions={[
            ...(suggested.length > 0
              ? [
                  {
                    label: 'Confirm matches',
                    disabled: !chosen.some((id) => suggested.includes(id)),
                    run: () => {
                      void faceAction('confirm', `Confirmed ${count}`)
                    },
                  },
                ]
              : []),
            {
              label: 'Not this person',
              run: () => {
                void faceAction('reject', `Removed ${count}`)
              },
            },
            {
              label: 'Split into new group',
              run: () => {
                void faceAction('split', `Split ${count} into a new group`)
              },
            },
            {
              label: 'Use as cover',
              disabled: chosen.length !== 1 || !faces.find((f) => f.faceId === chosen[0])?.hasCrop,
              run: () => {
                void run('Cover changed', () =>
                  peopleApi(`/api/people/${personId}`, 'PATCH', { coverFaceId: chosen[0] }),
                )
              },
            },
            {
              label: 'Ignore faces',
              run: () => {
                void run(`Ignored ${count}`, () =>
                  peopleApi('/api/people/ignore', 'POST', { faceIds: chosen, ignored: true }),
                )
              },
            },
          ]}
        >
          <PersonPicker
            exclude={[personId]}
            disabled={busy || chosen.length === 0}
            label="Move to"
            onPick={(target) =>
              'name' in target
                ? faceAction('move', `Moved ${count} to ${target.name}`, { name: target.name })
                : run(`Moved ${count}`, () =>
                    peopleApi('/api/people/assign', 'POST', { faceIds: chosen, ...target }),
                  )
            }
          />
        </SelectionToolbar>
      )}

      {readOnly && <div className="person-detail-controls">{heading}</div>}
      <div className="media-context-meta">
        <span>
          {person.photoCount} photos{person.reviewCount > 0 && ` · ${person.reviewCount} to review`}
          {person.hidden && ' · Hidden'}
        </span>
        {person.name && !person.hidden && (
          <Link href={`/search?person=${personId}`} className="media-sort">
            <Search size={14} />
            See photos
          </Link>
        )}
      </div>
      {faces.length === 0 ? (
        <p className="text-sm text-muted-foreground">No faces left for this person.</p>
      ) : (
        <FaceGrid
          faces={faces}
          selected={selection.selected}
          onToggle={readOnly ? undefined : selection.toggle}
        />
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground" role="status">
          {loadingMore ? 'Loading' : more ? 'Showing' : 'Showing all'} {faces.length} faces
          {more && !loadingMore ? ' · More faces are available.' : '.'}
        </p>
        {more && (
          <>
            <button
              type="button"
              className={button}
              disabled={busy || loadingMore}
              onClick={() => void loadMore()}
            >
              Load more
            </button>
            <button
              type="button"
              className={button}
              disabled={busy || loadingMore}
              onClick={() => void loadMore(true)}
            >
              Load all faces
            </button>
          </>
        )}
      </div>
      {loadError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {loadError}{' '}
          <button
            type="button"
            className="underline"
            disabled={loadingMore || busy}
            onClick={() => void loadMore()}
          >
            Retry
          </button>
        </p>
      )}
      {!readOnly && faces.length > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          Select bad matches and choose “Not this person” to remove them and prevent future matching
          to this person. Choose “Ignore faces” for detections you want excluded.
        </p>
      )}
      {faces.length === 0 && !readOnly && (
        <button type="button" className="text-sm underline mt-3" onClick={backToPeople}>
          {backLabel}
        </button>
      )}
    </div>
  )
}
