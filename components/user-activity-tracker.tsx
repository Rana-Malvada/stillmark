'use client'
import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/components/auth-provider'
import { acknowledgeActivity, pendingActivity, queueActivity } from '@/lib/browser-activity'

export function UserActivityTracker() {
  const path = usePathname()
  const { authenticated } = useAuth()
  useEffect(() => {
    if (authenticated) queueActivity({ path })
  }, [path, authenticated])
  useEffect(() => {
    if (!authenticated) return
    let stopped = false
    let busy = false
    let lastInput = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function flush(final = false) {
      const batch = pendingActivity()
      if (
        stopped ||
        busy ||
        (!final && (document.visibilityState !== 'visible' || Date.now() - lastInput > 60_000)) ||
        (!batch.length && final)
      )
        return
      busy = true
      try {
        const response = await fetch('/api/user-activity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: batch }),
          keepalive: final,
          signal: AbortSignal.timeout(5000),
        })
        // A permanent validation rejection must not poison every later batch.
        // Network errors and transient server failures retain the same IDs for retry.
        if (response.ok || response.status === 400)
          acknowledgeActivity(new Set(batch.map((v) => v.id)))
      } catch {
        /* Retry the same IDs while the page remains open. */
      } finally {
        busy = false
      }
    }
    const input = () => {
      lastInput = Date.now()
    }
    const queued = () => {
      input()
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined
          void flush()
        }, 1500)
    }
    const hidden = () => {
      if (document.visibilityState === 'hidden') void flush(true)
    }
    const leaving = () => {
      void flush(true)
    }
    for (const e of ['pointerdown', 'keydown', 'scroll'])
      window.addEventListener(e, input, { passive: true })
    window.addEventListener('gallery-activity', queued)
    window.addEventListener('pagehide', leaving)
    document.addEventListener('visibilitychange', hidden)
    const tick = setInterval(() => {
      void flush()
    }, 60_000)
    queued()
    return () => {
      stopped = true
      clearInterval(tick)
      clearTimeout(timer)
      for (const e of ['pointerdown', 'keydown', 'scroll']) window.removeEventListener(e, input)
      window.removeEventListener('gallery-activity', queued)
      window.removeEventListener('pagehide', leaving)
      document.removeEventListener('visibilitychange', hidden)
    }
  }, [authenticated])
  return null
}
