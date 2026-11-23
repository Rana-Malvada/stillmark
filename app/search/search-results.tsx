'use client'
import { clientOperation } from '@/lib/client-operation'
import {
  type SearchAlbum as EventResult,
  isAlbumSearchPage,
  isPhotoSearchPage,
  type SearchPerson as PersonMatch,
  type SearchSuggestion as PersonSuggestion,
  type SearchPhoto as SearchResult,
} from '@/lib/frontend-response-contracts'
import { VirtualPhotoGrid } from '@/components/virtual-photo-grid'
import { Thumbnail } from '@/components/thumbnail'
import { replacePersonName } from '@/lib/person-name'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, Loader2, Search, UserRound, X } from 'lucide-react'
import Link from 'next/link'
import { useAuth } from '@/components/auth-provider'
import { rememberGalleryPosition, useGalleryPosition } from '@/components/gallery-position'
import { AlbumCard, albumGridClass } from '@/components/album-card'
import { PhotoCard } from '@/components/photo-card'

async function fetchSearchPage(albums: boolean, params: URLSearchParams, signal: AbortSignal) {
  if (albums)
    return {
      kind: 'albums' as const,
      ...(await clientOperation(
        `/api/search/events?${params}`,
        { signal },
        'Search failed. Please retry.',
        isAlbumSearchPage,
      )),
    }
  return {
    kind: 'photos' as const,
    ...(await clientOperation(
      `/api/search?${params}`,
      { signal },
      'Search failed. Please retry.',
      isPhotoSearchPage,
    )),
  }
}

function FaceThumb({ faceId, name, size }: { faceId: number | null; name: string; size: string }) {
  return faceId ? (
    <Thumbnail
      src={`/api/faces/${faceId}/crop`}
      alt=""
      className={`${size} rounded-full object-cover bg-muted shrink-0`}
    />
  ) : (
    <span
      aria-hidden="true"
      className={`${size} rounded-full bg-muted flex items-center justify-center shrink-0`}
      title={name}
    >
      <UserRound className="w-1/2 h-1/2 text-muted-foreground" />
    </span>
  )
}

export default function SearchResults() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { username } = useAuth()
  const q = searchParams.get('q') || ''
  const type = searchParams.get('type') || 'photos'
  const personParams = searchParams.getAll('person')
  const personKey = personParams.join(',')

  const [inputValue, setInputValue] = useState(q)
  const [mode, setMode] = useState<'photos' | 'albums'>(type === 'albums' ? 'albums' : 'photos')

  const [photoResults, setPhotoResults] = useState<SearchResult[]>([])
  const [albumResults, setAlbumResults] = useState<EventResult[]>([])
  const [searchMs, setSearchMs] = useState(0)
  const [loading, setLoading] = useState(false)
  const requestNumber = useRef(0)
  const searchAbort = useRef<AbortController | null>(null)
  const moreAbort = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      searchAbort.current?.abort()
      moreAbort.current?.abort()
      requestNumber.current++
    },
    [],
  )
  const [error, setError] = useState<string | null>(null)
  const [clarification, setClarification] = useState<string | null>(null)
  const [interpretation, setInterpretation] = useState<{
    elapsedMs: number
    inputTokens: number | null
    outputTokens: number | null
  } | null>(null)
  const [source, setSource] = useState('postgres')
  const [people, setPeople] = useState<PersonMatch[]>([])
  const [suggestions, setSuggestions] = useState<PersonSuggestion[]>([])
  const related = searchParams.get('related') === 'true'
  const [relatedAvailable, setRelatedAvailable] = useState(false)
  const semantic = searchParams.get('mode') === 'semantic'
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [ranking, setRanking] = useState('live')
  const [loadingMore, setLoadingMore] = useState(false)
  const [candidateCount, setCandidateCount] = useState(0)
  const [countIsExact, setCountIsExact] = useState(false)
  const [countIsLowerBound, setCountIsLowerBound] = useState(false)
  const [searched, setSearched] = useState(false)
  useGalleryPosition(searched && !loading && !error)

  const doSearch = useCallback(
    async (
      query: string,
      searchMode: string,
      byMeaning: boolean,
      personIds: string[],
      includeRelated: boolean,
    ) => {
      if (!query.trim() && !personIds.length) return
      const started = performance.now()
      searchAbort.current?.abort()
      moreAbort.current?.abort()
      const controller = new AbortController()
      searchAbort.current = controller
      const request = ++requestNumber.current
      setLoadingMore(false)
      setLoading(true)
      setError(null)
      setNextCursor(null)
      setRelatedAvailable(false)
      setClarification(null)
      setInterpretation(null)
      setSearched(true)
      try {
        const params = new URLSearchParams({
          q: query,
          limit: '50',
          mode: byMeaning ? 'semantic' : 'auto',
        })
        if (includeRelated) params.set('related', 'true')
        for (const id of personIds) params.append('person', id)
        const data = await fetchSearchPage(searchMode === 'albums', params, controller.signal)
        if (request !== requestNumber.current) return
        setRelatedAvailable(data.relatedAvailable === true)
        setClarification(data.clarification ?? data.notice ?? null)
        setInterpretation(data.interpretation ?? null)
        setSource(data.source)
        setNextCursor(data.nextCursor ?? null)
        setRanking(data.ranking ?? 'live')
        setCandidateCount(data.candidateCount ?? data.count)
        setCountIsExact(data.countIsExact ?? false)
        setCountIsLowerBound(data.countIsLowerBound === true)
        setPeople(data.people ?? [])
        setSuggestions(data.suggestions ?? [])
        setAlbumResults(data.kind === 'albums' ? data.results : [])
        setPhotoResults(data.kind === 'photos' ? data.results : [])
      } catch (e) {
        if (request !== requestNumber.current) return
        setError(e instanceof Error ? e.message : 'Search failed')
        setPhotoResults([])
        setAlbumResults([])
        setPeople([])
        setSuggestions([])
      } finally {
        if (request === requestNumber.current) {
          setSearchMs(Math.round(performance.now() - started))
          setLoading(false)
        }
      }
    },
    [],
  )

  useEffect(() => {
    if (q || personKey) {
      // oxlint-disable-next-line react/set-state-in-effect -- the URL is the source of truth; the form and results must change with the abort and request-number bump in this effect, or a late response could repopulate cleared results
      setInputValue(q)
      setMode(type === 'albums' ? 'albums' : 'photos')
      doSearch(q, type, semantic, personKey ? personKey.split(',') : [], related)
    } else {
      searchAbort.current?.abort()
      moreAbort.current?.abort()
      requestNumber.current++
      setLoading(false)
      setLoadingMore(false)
      setInputValue('')
      setMode(type === 'albums' ? 'albums' : 'photos')
      setPhotoResults([])
      setAlbumResults([])
      setPeople([])
      setSuggestions([])
      setNextCursor(null)
      setCandidateCount(0)
      setCountIsExact(false)
      setCountIsLowerBound(false)
      setRelatedAvailable(false)
      setClarification(null)
      setInterpretation(null)
      setSource('postgres')
      setRanking('live')
      setSearchMs(0)
      setError(null)
      setSearched(false)
    }
  }, [q, type, semantic, personKey, related, doSearch])

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    const request = requestNumber.current
    moreAbort.current?.abort()
    const controller = new AbortController()
    moreAbort.current = controller
    setLoadingMore(true)
    try {
      const params = new URLSearchParams({ cursor: nextCursor, limit: '50', ranking })
      const data = await fetchSearchPage(mode === 'albums', params, controller.signal)
      if (request !== requestNumber.current || controller.signal.aborted) return
      if (data.kind === 'albums') setAlbumResults((old) => [...old, ...data.results])
      else setPhotoResults((old) => [...old, ...data.results])
      setNextCursor(data.nextCursor ?? null)
      setCandidateCount(data.candidateCount ?? data.count)
      setCountIsExact(data.countIsExact ?? false)
      setCountIsLowerBound(data.countIsLowerBound === true)
    } catch (error) {
      if (request === requestNumber.current && !controller.signal.aborted)
        setError(error instanceof Error ? error.message : 'Could not load more results')
    } finally {
      if (request === requestNumber.current && !controller.signal.aborted) setLoadingMore(false)
    }
  }

  function searchUrl(next: {
    q?: string
    type?: string
    people?: string[]
    semantic?: boolean
    related?: boolean
  }) {
    const params = new URLSearchParams()
    const text = next.q ?? q
    if (text) params.set('q', text)
    params.set('type', next.type ?? mode)
    for (const id of next.people ?? personParams) params.append('person', id)
    if (next.semantic) params.set('mode', 'semantic')
    if (next.related) params.set('related', 'true')
    return `/search?${params}`
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = inputValue.trim()
    if (!trimmed && !personParams.length) return
    if (trimmed === q && mode === type && !semantic && !related)
      void doSearch(q, type, false, personParams, false)
    else router.push(searchUrl({ q: trimmed }))
  }

  function switchMode(newMode: 'photos' | 'albums') {
    setMode(newMode)
    if (q || personParams.length) router.push(searchUrl({ type: newMode }))
  }

  /** Removes a person from the search, whether chosen by link or typed by name. */
  function removePerson(person: PersonMatch) {
    const text = replacePersonName(q, person.name, '')
    router.push(searchUrl({ q: text, people: personParams.filter((id) => id !== person.personId) }))
  }

  const label = q || people.map((p) => p.name).join(' & ')

  const resultCount = mode === 'albums' ? albumResults.length : photoResults.length

  return (
    <main className="w-full min-w-0 mx-auto px-5 sm:px-8 py-5">
      <Link
        href="/"
        className="inline-flex min-h-11 items-center gap-2 mb-2 rounded-lg text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4" aria-hidden="true" />
        Back to collection
      </Link>
      <div className="mb-4">
        <p className="eyebrow mb-1.5">Rediscover a moment</p>
        <h1 className="page-title">Explore your library.</h1>
      </div>
      <div className="mb-4">
        <form onSubmit={handleSubmit} className="flex min-w-0 items-stretch gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-card px-3 py-3 shadow-sm sm:px-5">
            <Search
              className="hidden sm:block w-4 h-4 text-muted-foreground shrink-0"
              aria-hidden="true"
            />
            <input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={
                mode === 'albums' ? 'Search albums or people...' : 'Search photos or people...'
              }
              className="bg-transparent text-base sm:text-sm outline-none flex-1 min-w-0 placeholder:text-muted-foreground"
              aria-label="Search your library"
              enterKeyHint="search"
            />
          </div>
          <button type="submit" className="control shrink-0" aria-label="Run search">
            {loading ? (
              <Loader2 aria-label="Searching" className="w-4 h-4 animate-spin" />
            ) : (
              'Search'
            )}
          </button>
        </form>
      </div>

      {/* Photos / Albums toggle */}
      <div className="grid grid-cols-2 gap-1 mb-4 bg-muted rounded-lg p-1 w-full sm:w-fit">
        <button
          onClick={() => switchMode('photos')}
          className={`min-h-11 px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
            mode === 'photos'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Photos
        </button>
        <button
          onClick={() => switchMode('albums')}
          className={`min-h-11 px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
            mode === 'albums'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Albums
        </button>
      </div>

      {people.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4" aria-label="People in this search">
          {people.map((person) => (
            <span
              key={person.personId}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card pl-3 pr-1 py-1 text-sm"
            >
              <UserRound className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
              {person.name}
              <button
                type="button"
                onClick={() => removePerson(person)}
                className="min-h-11 min-w-11 flex items-center justify-center rounded-full hover:bg-muted"
                aria-label={`Remove ${person.name} from search`}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {!loading && clarification && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          {clarification}
        </p>
      )}
      {!loading && relatedAvailable && (
        <button
          className="text-sm underline mb-4"
          onClick={() => router.push(searchUrl({ semantic, related: true }))}
        >
          Show related photos
        </button>
      )}
      {!loading && (mode === 'photos' || clarification) && suggestions.length > 0 && (
        <section className="mb-6" aria-labelledby="people-heading">
          <h2 id="people-heading" className="text-sm font-medium mb-2">
            People
          </h2>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {suggestions.map((person) => (
              <Link
                key={person.personId}
                href={searchUrl({
                  q: person.query ?? '',
                  type: mode,
                  people: [...new Set([...personParams, person.personId])],
                })}
                className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2 hover:bg-muted transition-colors shrink-0"
              >
                <FaceThumb faceId={person.coverFaceId} name={person.name} size="w-10 h-10" />
                <span className="text-left">
                  <span className="block text-sm font-medium">{person.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {person.photoCount} photo{person.photoCount !== 1 ? 's' : ''}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {q && !loading && !clarification && source !== 'semantic' && (
        <button
          className="text-sm underline mb-4"
          onClick={() => router.push(searchUrl({ semantic: true }))}
        >
          Search by meaning
        </button>
      )}
      {searched && !loading && !error && (
        <p className="text-xs text-muted-foreground mb-3">
          Total search {(searchMs / 1000).toFixed(2)}s ·{' '}
          {interpretation
            ? `AI interpretation (direct API) · ${(interpretation.elapsedMs / 1000).toFixed(2)}s · ${interpretation.inputTokens ?? 'unknown'} input / ${interpretation.outputTokens ?? 'unknown'} output tokens · billed cost pending Snowflake usage`
            : 'Basic search · no LLM interpretation call'}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive mb-4">
          {error}
        </p>
      )}
      {searched && !loading && !error && !clarification && (
        <p className="text-sm text-muted-foreground mb-4">
          {source === 'semantic' && <span>Matches by meaning · </span>}
          {resultCount === 0
            ? `No ${mode === 'albums' ? 'albums' : 'photos'} found for "${label}"`
            : `Showing ${resultCount} ${mode === 'albums' ? 'albums' : 'photos'} · ${countIsLowerBound ? 'at least ' : ''}${candidateCount} ${countIsExact ? 'total' : countIsLowerBound ? 'matches' : 'ranked matches'} for "${label}"`}
        </p>
      )}

      {loading && (
        <div className="flex items-center justify-center min-h-[40vh]">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Photo results */}
      {!loading && mode === 'photos' && photoResults.length > 0 && (
        <VirtualPhotoGrid
          items={photoResults}
          render={(r) => (
            <PhotoCard
              filename={r.sourceFilename}
              alt={r.caption ?? undefined}
              thumbnailUrl={r.thumbnailUrl}
              key={r.photoId}
              onClick={() => {
                rememberGalleryPosition(username, `photo-grid:${r.eventId}`)
                router.push(`/photos/${r.photoId}`)
              }}
            >
              {r.caption && (
                <p className="absolute bottom-0 inset-x-0 bg-scrim/65 text-on-image px-2 py-1 text-xs text-left truncate">
                  {r.caption}
                </p>
              )}
            </PhotoCard>
          )}
        />
      )}

      {/* Album results */}
      {!loading && mode === 'albums' && albumResults.length > 0 && (
        <div className={albumGridClass}>
          {albumResults.map((e) => (
            <AlbumCard key={e.eventId} event={e} prefetch={false} />
          ))}
        </div>
      )}
      {nextCursor && !loading && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          className="mt-6 rounded-lg border border-border px-5 py-3 hover:bg-muted disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Show more'}
        </button>
      )}
    </main>
  )
}
