'use client'
import { type ComponentProps, forwardRef, useEffect, useRef } from 'react'
import { queueActivity } from '@/lib/browser-activity'
import { watchedSeconds } from '@/lib/watch-time'

export const TrackedVideo = forwardRef<
  HTMLVideoElement,
  ComponentProps<'video'> & { photoId: number }
>(function TrackedVideo({ photoId, onPlay, onError, ...props }, forwarded) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const started = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    started.current = false
    let last = performance.now()
    let position = el.currentTime
    let seconds = 0
    const emit = () => {
      if (seconds > 0) {
        queueActivity({
          path: `/photos/${photoId}`,
          kind: 'video_watch',
          seconds: Math.min(seconds, 60),
        })
        seconds = 0
      }
    }
    const sample = () => {
      const now = performance.now()
      seconds += watchedSeconds(
        (now - last) / 1000,
        el.currentTime - position,
        el.playbackRate,
        !el.paused &&
          !el.ended &&
          !el.seeking &&
          el.readyState >= 3 &&
          document.visibilityState === 'visible',
      )
      last = now
      position = el.currentTime
      if (seconds >= 15) emit()
    }
    const reset = () => {
      last = performance.now()
      position = el.currentTime
    }
    const stop = () => {
      sample()
      emit()
      reset()
    }
    const visibility = () => {
      emit()
      reset()
    }
    const tick = setInterval(sample, 1000)
    el.addEventListener('pause', stop)
    el.addEventListener('ended', stop)
    el.addEventListener('seeking', reset)
    el.addEventListener('seeked', reset)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      sample()
      emit()
      clearInterval(tick)
      el.removeEventListener('pause', stop)
      el.removeEventListener('ended', stop)
      el.removeEventListener('seeking', reset)
      el.removeEventListener('seeked', reset)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [photoId])
  return (
    <video
      {...props}
      ref={(el) => {
        ref.current = el
        if (typeof forwarded === 'function') forwarded(el)
        else if (forwarded) forwarded.current = el
      }}
      onPlay={(e) => {
        if (!started.current) {
          started.current = true
          queueActivity({ path: `/photos/${photoId}`, kind: 'video_started' })
        }
        onPlay?.(e)
      }}
      onError={(e) => {
        queueActivity({ path: `/photos/${photoId}`, kind: 'video_error' })
        onError?.(e)
      }}
    />
  )
})
