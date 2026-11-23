'use client'
import { type ComponentProps, useEffect, useRef, useState } from 'react'
import type Hls from 'hls.js'
import { TrackedVideo } from './tracked-video'
import { VideoDiagnostics } from './video-diagnostics'

export function BufferedVideo(props: ComponentProps<typeof TrackedVideo>) {
  const video = useRef<HTMLVideoElement | null>(null)
  const stream = useRef<Hls | null>(null)
  const [source, setSource] = useState<ComponentProps<typeof TrackedVideo>['src']>()
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const restore = useRef<{ time: number; rate: number } | null>(null)
  useEffect(() => {
    const el = video.current
    if (!el) return
    const controller = new AbortController()
    let disposed = false
    setSource(undefined)
    setFailed(false)
    const fallback = () => {
      if (!disposed) {
        stream.current?.destroy()
        stream.current = null
        el.dataset.playbackMode = 'original'
        setSource(props.src)
      }
    }
    const deadline = setTimeout(() => {
      controller.abort()
      if (!disposed) setFailed(true)
    }, 45_000)
    void (async () => {
      const url = `/api/videos/${props.photoId}/playlist`
      const response = await fetch(url, {
        signal: controller.signal,
        cache: 'no-store',
      })
      if (disposed || controller.signal.aborted) return
      if (response.status === 204) {
        fallback()
        return
      }
      if (!response.ok) throw new Error('Video unavailable')
      await response.body?.cancel()
      if (disposed || controller.signal.aborted) return
      if (el.canPlayType('application/vnd.apple.mpegurl')) {
        el.dataset.playbackMode = 'native-hls'
        setSource(url)
        return
      }
      const { default: Hls } = await import('hls.js')
      if (disposed || controller.signal.aborted) return
      if (!Hls.isSupported()) {
        fallback()
        return
      }
      el.dataset.playbackMode = 'hls'
      const hls = new Hls({
        enableWorker: false,
        maxBufferLength: 20,
        maxMaxBufferLength: 30,
        backBufferLength: 5,
        maxBufferSize: 32 * 1024 * 1024,
      })
      stream.current = hls
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal && !disposed) setFailed(true)
      })
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (props.autoPlay) void el.play().catch(() => {})
      })
      hls.loadSource(url)
      hls.attachMedia(el)
    })()
      .catch(() => {
        // Deadline expiry is shown by the timer; cleanup must stay silent.
        if (!disposed && !controller.signal.aborted) setFailed(true)
      })
      .finally(() => clearTimeout(deadline))
    return () => {
      disposed = true
      clearTimeout(deadline)
      controller.abort()
      stream.current?.destroy()
      stream.current = null
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- attempt is the Retry trigger for a failed or timed-out stream
  }, [props.photoId, props.src, props.autoPlay, attempt])
  return (
    <>
      <TrackedVideo
        {...props}
        src={source}
        ref={video}
        preload="auto"
        onError={(e) => {
          setFailed(true)
          props.onError?.(e)
        }}
        onPlaying={(e) => {
          setFailed(false)
          props.onPlaying?.(e)
        }}
        onLoadedMetadata={(e) => {
          if (restore.current) {
            e.currentTarget.currentTime = restore.current.time
            e.currentTarget.playbackRate = restore.current.rate
            restore.current = null
          }
          props.onLoadedMetadata?.(e)
        }}
      />
      {failed && (
        <button
          type="button"
          className="absolute top-16 z-20 rounded bg-scrim/80 px-4 py-3 text-on-image"
          onClick={() => {
            const el = video.current
            if (!el) return
            if (!el.currentSrc) {
              setAttempt((n) => n + 1)
              return
            }
            restore.current = {
              time: Number.isFinite(el.currentTime) ? el.currentTime : 0,
              rate: el.playbackRate,
            }
            setFailed(false)
            if (stream.current) {
              stream.current.recoverMediaError()
              stream.current.startLoad(el.currentTime)
            } else el.load()
            void el.play().catch(() => setFailed(true))
          }}
        >
          Playback interrupted · Retry
        </button>
      )}
      <VideoDiagnostics video={video} />
    </>
  )
}
