'use client'
import { TrackedVideo } from '@/components/tracked-video'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { loadSlideshowPage, type SlideshowMedia as Media } from './gallery/slideshow-data'

export function Slideshow({ eventId }: { eventId: number }) {
  const router = useRouter()
  const params = useSearchParams()
  const query = params.toString()
  const [files, setFiles] = useState<Media[]>([])
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [seconds, setSeconds] = useState(5)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [pageError, setPageError] = useState<{ message: string; initial: boolean } | null>(null)
  const [initialRetry, setInitialRetry] = useState(0)
  const [pageRetry, setPageRetry] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [jumpLast, setJumpLast] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const photoImage = useRef<HTMLImageElement>(null)
  const current = files[index]
  const advance = useCallback(
    (step = 1) => {
      if (step < 0 && index === 0 && nextCursor) {
        setJumpLast(true)
        return
      }
      if (step > 0 && index === files.length - 1 && nextCursor) return
      setReady(false)
      setError('')
      setIndex((i) => (i + step + files.length) % files.length)
    },
    [files.length, index, nextCursor],
  )
  useEffect(() => {
    const controller = new AbortController()
    // oxlint-disable-next-line react/set-state-in-effect -- the reset must follow the previous album's abort in this effect, or its late page could repopulate the new slideshow
    setFiles([])
    setNextCursor(null)
    setLoadingMore(false)
    setError('')
    setPageError(null)
    setLoaded(false)
    setIndex(0)
    setReady(false)
    setJumpLast(false)
    loadSlideshowPage(eventId, query, controller.signal)
      .then((d) => {
        if (controller.signal.aborted) return
        setFiles(d.items)
        setNextCursor(d.nextCursor)
        setLoaded(true)
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setPageError({ message: e.message, initial: true })
          setLoaded(true)
        }
      })
    return () => controller.abort()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- initialRetry is the Retry trigger for a failed first page
  }, [eventId, query, initialRetry])
  useEffect(() => {
    if (!loaded || !nextCursor || pageError || (!jumpLast && index < files.length - 3)) return
    const controller = new AbortController()
    // oxlint-disable-next-line react/set-state-in-effect -- raised after the previous continuation is aborted in this effect, or its completion could clear the flag mid-load
    setLoadingMore(true)
    loadSlideshowPage(eventId, query, controller.signal, nextCursor)
      .then((d) => {
        if (controller.signal.aborted) return
        setFiles((old) => {
          const ids = new Set(old.map((p) => p.photoId))
          return [
            ...old,
            ...d.items.filter((p: Media) => {
              if (ids.has(p.photoId)) return false
              ids.add(p.photoId)
              return true
            }),
          ]
        })
        setNextCursor(d.nextCursor)
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setLoadingMore(false)
          setPageError({ message: e.message, initial: false })
          setPlaying(false)
          setJumpLast(false)
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingMore(false)
      })
    return () => controller.abort()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- pageRetry is the Retry trigger for a failed continuation page
  }, [loaded, nextCursor, index, files.length, jumpLast, eventId, query, pageRetry, pageError])
  // A pending jump to the end resolves in the render that delivers the last page.
  if (jumpLast && !nextCursor && files.length) {
    setIndex(files.length - 1)
    setReady(false)
    setJumpLast(false)
  }
  useEffect(() => {
    if (
      current?.mediaType !== 'video' &&
      photoImage.current?.complete &&
      photoImage.current.naturalWidth
    )
      setReady(true)
  }, [current])
  useEffect(() => {
    if (!playing || !ready || current?.mediaType === 'video' || files.length < 2) return
    const timer = setTimeout(() => advance(), seconds * 1000)
    return () => clearTimeout(timer)
  }, [playing, ready, current, seconds, advance, files.length])
  useEffect(() => {
    if (!video.current) return
    if (playing) void video.current.play().catch(() => setPlaying(false))
    else video.current.pause()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- index and ready are triggers: a newly shown or newly ready <video> must receive the current play state
  }, [playing, index, ready])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,select,button')) return
      if (e.key === 'Escape') router.push(`/events/${eventId}`)
      if (e.key === 'ArrowRight' && files.length) advance()
      if (e.key === 'ArrowLeft' && files.length) advance(-1)
      if (e.key === ' ') {
        e.preventDefault()
        setPlaying((p) => !p)
      }
    }
    const hide = () => {
      if (document.hidden) setPlaying(false)
    }
    window.addEventListener('keydown', key)
    document.addEventListener('visibilitychange', hide)
    return () => {
      window.removeEventListener('keydown', key)
      document.removeEventListener('visibilitychange', hide)
    }
  }, [advance, eventId, router, files.length])
  const path = current?.displayStagePath ?? current?.originalStagePath
  const src = path ? `/api/images?${new URLSearchParams({ path })}` : null
  return (
    <div ref={root} className="dark fixed inset-0 z-50 bg-background text-foreground flex flex-col">
      <div className="viewer-toolbar flex flex-wrap items-center gap-4 px-5 py-4 text-sm">
        <button onClick={() => router.push(`/events/${eventId}`)}>Close</button>
        <button disabled={!files.length || jumpLast} onClick={() => advance(-1)}>
          Previous
        </button>
        <button onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause' : 'Play'}</button>
        <button
          disabled={!files.length || (index === files.length - 1 && !!nextCursor)}
          onClick={() => advance()}
        >
          Next
        </button>
        <label>
          Photo interval{' '}
          <select
            className="bg-muted rounded p-1"
            value={seconds}
            onChange={(e) => setSeconds(Number(e.target.value))}
          >
            {[3, 5, 10, 15].map((n) => (
              <option key={n} value={n}>
                {n}s
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen()
            else
              void root.current
                ?.requestFullscreen()
                .catch(() => setError('Full-screen mode is unavailable in this browser'))
          }}
        >
          Full screen
        </button>
        <span className="ml-auto text-sm">
          {files.length ? index + 1 : 0} / {files.length}
          {nextCursor ? '+' : ''}
          {loadingMore ? ' · Loading more…' : ''}
        </span>
      </div>
      {error && (
        <p role="alert" className="p-3 text-destructive">
          {error} Use Next to skip.
        </p>
      )}
      {pageError && (
        <p role="alert" className="p-3 text-destructive">
          {pageError.message}{' '}
          <button
            className="control"
            onClick={() => {
              if (pageError.initial) setInitialRetry((n) => n + 1)
              else setPageRetry((n) => n + 1)
              setPageError(null)
            }}
          >
            Retry loading photos
          </button>
        </p>
      )}
      <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden">
        {!loaded ? (
          <p>Loading album…</p>
        ) : !current ? (
          <p>
            {pageError
              ? 'Photos could not be loaded. Retry to continue.'
              : 'No media matches these filters.'}
          </p>
        ) : !src ? (
          <p>Preview unavailable. Use Next to skip.</p>
        ) : current.mediaType === 'video' ? (
          <TrackedVideo
            photoId={current.photoId}
            ref={video}
            key={current.photoId}
            src={src}
            controls
            muted
            playsInline
            autoPlay={playing}
            className="h-full w-full object-contain"
            onLoadedData={() => setReady(true)}
            onEnded={() => {
              if (playing && files.length > 1) advance()
              else setPlaying(false)
            }}
            onError={() => {
              setPlaying(false)
              setError('Video could not be loaded')
            }}
          />
        ) : (
          <>
            {[current, files[(index + 1) % files.length]]
              .filter(
                (p, i, a) =>
                  p?.mediaType !== 'video' && a.findIndex((q) => q?.photoId === p?.photoId) === i,
              )
              .map((photo) => (
                <img
                  key={photo.photoId}
                  src={`/api/images?${new URLSearchParams({ path: photo.displayStagePath ?? photo.originalStagePath ?? '' })}`}
                  alt={photo.sourceFilename}
                  className={
                    photo.photoId === current.photoId ? 'h-full w-full object-contain' : 'hidden'
                  }
                  aria-hidden={photo.photoId !== current.photoId}
                  ref={photo.photoId === current.photoId ? photoImage : undefined}
                  onLoad={() => {
                    if (photo.photoId === current.photoId) setReady(true)
                  }}
                  onError={() => {
                    if (photo.photoId === current.photoId) {
                      setPlaying(false)
                      setError('Photo could not be loaded')
                    }
                  }}
                />
              ))}
          </>
        )}
      </div>
      <p className="p-2 text-center text-sm text-foreground/70">{current?.sourceFilename}</p>
    </div>
  )
}
