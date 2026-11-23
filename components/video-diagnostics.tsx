'use client'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { useClientValue } from './use-client-value'

/** Opt-in, local-only measurements. Never sends video URLs or playback samples. */
export function VideoDiagnostics({ video }: { video: RefObject<HTMLVideoElement | null> }) {
  const output = useRef<HTMLOutputElement | null>(null)
  // Decided once per mount, as before: later URL changes do not toggle diagnostics.
  const [debugRequested] = useState(() => {
    let requested: boolean | undefined
    return () => (requested ??= new URLSearchParams(location.search).get('playbackDebug') === '1')
  })
  const enabled = useClientValue(debugRequested, false)
  useEffect(() => {
    const el = video.current
    const target = output.current
    if (!enabled || !el || !target) return
    const started = performance.now()
    let played = false
    let waitingAt: number | null = null
    let waitSeconds = 0
    let waits = 0
    const events: object[] = []
    const ahead = () => {
      for (let i = 0; i < el.buffered.length; i++)
        if (el.buffered.start(i) <= el.currentTime + 0.05 && el.buffered.end(i) >= el.currentTime)
          return el.buffered.end(i) - el.currentTime
      return 0
    }
    const rounded = (n: number) => Math.round(n * 100) / 100
    const paint = () => {
      const q = el.getVideoPlaybackQuality?.()
      const data = {
        elapsed: rounded((performance.now() - started) / 1000),
        position: rounded(el.currentTime),
        bufferAhead: rounded(ahead()),
        ready: el.readyState,
        paused: el.paused,
        seeking: el.seeking,
        ended: el.ended,
        waits,
        waitSeconds: rounded(
          waitSeconds + (waitingAt === null ? 0 : (performance.now() - waitingAt) / 1000),
        ),
        dropped: q?.droppedVideoFrames,
        frames: q?.totalVideoFrames,
        events: events.slice(-12),
      }
      const result = { mode: el.dataset.playbackMode, ...data }
      target.textContent = JSON.stringify(result)
      target.dataset.playback = JSON.stringify(result)
    }
    const finishWait = () => {
      if (waitingAt !== null) {
        waitSeconds += (performance.now() - waitingAt) / 1000
        waitingAt = null
      }
    }
    const record = (event: Event) => {
      const type = event.type
      if (type === 'waiting' && played && !el.paused && !el.seeking && waitingAt === null) {
        waitingAt = performance.now()
        waits++
      }
      if (['playing', 'pause', 'ended', 'seeking'].includes(type)) finishWait()
      if (type === 'playing') played = true
      events.push({
        event: type,
        at: rounded((performance.now() - started) / 1000),
        position: rounded(el.currentTime),
        ahead: rounded(ahead()),
        ready: el.readyState,
      })
      if (events.length > 200) events.shift()
      paint()
    }
    const names = [
      'playing',
      'waiting',
      'stalled',
      'suspend',
      'pause',
      'seeking',
      'seeked',
      'ended',
      'error',
      'loadedmetadata',
    ]
    names.forEach((name) => el.addEventListener(name, record))
    const timer = setInterval(paint, 500)
    paint()
    return () => {
      clearInterval(timer)
      names.forEach((name) => el.removeEventListener(name, record))
    }
  }, [enabled, video])
  return enabled ? (
    <output
      ref={output}
      aria-label="Playback diagnostics"
      className="pointer-events-none absolute bottom-20 left-2 right-2 z-30 max-h-40 overflow-hidden whitespace-pre-wrap rounded bg-scrim/85 p-2 text-[10px] text-on-image"
    />
  ) : null
}
