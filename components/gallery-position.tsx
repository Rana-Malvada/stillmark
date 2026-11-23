'use client'
import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from './auth-provider'

const prefix = 'gallery-position-v1:'
function read(key: string) {
  try {
    return JSON.parse(sessionStorage.getItem(prefix + key) || 'null')
  } catch {
    return null
  }
}
function write(key: string, value: unknown) {
  try {
    sessionStorage.setItem(prefix + key, JSON.stringify(value))
  } catch {
    // Storage blocked or full: browsing works, the position just is not remembered.
  }
}
export function rememberGalleryPosition(username: string | null, child: string) {
  if (!username) return
  const path = location.pathname + location.search
  write(`${username}:position:${path}`, { y: window.scrollY })
  write(`${username}:parent:${child}`, path)
}
export function rememberGalleryParent(username: string | null, child: string, path: string) {
  if (username) write(`${username}:parent:${child}`, path)
}
export function galleryParent(username: string | null, child: string, fallback: string): string {
  const path = read(`${username}:parent:${child}`)
  return typeof path === 'string' &&
    /^\/(?:$|my-albums(?:\?|$)|favorites(?:\?|$)|search(?:\?|$)|events\/\d+(?:\?|$)|people(?:\/[0-9a-f-]{36})?(?:\?|$))/.test(
      path,
    )
    ? path
    : fallback
}
export function requestGalleryReturn(username: string | null, path: string) {
  if (username) write(`${username}:restore-once`, path)
  return path
}
export function takeGalleryReturn(username: string, path: string) {
  const target = read(`${username}:restore-once`)
  write(`${username}:restore-once`, null)
  return target === path
}
export interface GalleryReturnIntent {
  username: string
  path: string
  returning: boolean
}
/** Capture once per visit; pagination and scroll must use the same decision. */
export function useGalleryReturn(enabled = true): GalleryReturnIntent | null {
  const { username } = useAuth()
  const pathname = usePathname()
  const captured = useRef<GalleryReturnIntent | null>(null)
  const [intent, setIntent] = useState<GalleryReturnIntent | null>(null)
  useEffect(() => {
    if (!enabled || !username) return
    const path = location.pathname + location.search
    // Keep the captured value through StrictMode's effect cleanup/replay.
    if (captured.current?.username !== username || captured.current.path !== path)
      captured.current = { username, path, returning: takeGalleryReturn(username, path) }
    setIntent(captured.current)
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- pathname re-runs the capture after a client navigation; the effect reads window.location, which is not reactive
  }, [enabled, username, pathname])
  return enabled && intent?.username === username && intent.path.split('?')[0] === pathname
    ? intent
    : null
}
export function useGalleryPosition(ready: boolean, sharedIntent?: GalleryReturnIntent | null) {
  const ownIntent = useGalleryReturn(sharedIntent === undefined)
  const intent = sharedIntent === undefined ? ownIntent : sharedIntent
  const restored = useRef<GalleryReturnIntent | null>(null)
  useEffect(() => {
    if (!ready || !intent || restored.current === intent) return
    const { username, path, returning } = intent
    // Album entry starts at the top. Only an explicit photo return restores it.
    if (/^\/events\/\d+(?:\?|$)/.test(path) && !returning) return
    const saved = read(`${username}:position:${path}`)
    if (!saved || !Number.isFinite(saved.y) || saved.y < 0) return
    // Wait until the grid exists; thumbnail aspect ratios reserve its final height.
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        window.scrollTo({ top: saved.y, behavior: 'instant' })
        restored.current = intent
      })
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [ready, intent])
}
export function AlbumBack({ eventId }: { eventId: number }) {
  const router = useRouter()
  const { username } = useAuth()
  return (
    <button
      aria-label="Back to previous list"
      className="control !p-2.5 mt-1 text-muted-foreground hover:text-foreground"
      onClick={() =>
        router.push(galleryParent(username, `album:${eventId}`, '/'), { scroll: false })
      }
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="m15 18-6-6 6-6" />
      </svg>
    </button>
  )
}
