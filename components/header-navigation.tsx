'use client'

import {
  Children,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useChanged } from './use-changed'
import { createPortal } from 'react-dom'
import { usePathname } from 'next/navigation'
import { ChevronDown } from 'lucide-react'

export function HeaderNavigation({
  children,
  label = 'Main navigation',
  compactMobile = false,
  mobileLabel = 'Library',
  mobileActions,
}: {
  children: ReactNode
  label?: string
  compactMobile?: boolean
  mobileLabel?: string
  mobileActions?: ReactNode
}) {
  const menuId = useId()
  const links = Children.toArray(children)
  const linkCount = links.length
  const pathname = usePathname()
  const container = useRef<HTMLElement>(null)
  const measurements = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const focusOnOpen = useRef(false)
  const popupItems = useCallback(
    () =>
      Array.from(
        popup.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled])') ?? [],
      ).filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'),
    [],
  )
  const [position, setPosition] = useState<{
    left: number
    top: number
    width: number
    maxHeight: number
  } | null>(null)
  const [visible, setVisible] = useState(0)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    const nav = container.current
    const row = measurements.current
    if (!nav || !row) return
    const measure = () => {
      if (compactMobile && window.matchMedia('(max-width: 639px)').matches) {
        setVisible(0)
        return
      }
      if (compactMobile && window.matchMedia('(min-width: 1024px)').matches) {
        setVisible(linkCount)
        return
      }
      const items = Array.from(row.children) as HTMLElement[]
      const widths = items.slice(0, -1).map((item) => item.getBoundingClientRect().width)
      const gap = 4
      const total =
        widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap
      let count = widths.length
      if (total > nav.clientWidth) {
        const more = items.at(-1)!.getBoundingClientRect().width
        let used = more
        count = 0
        for (const width of widths) {
          if (used + gap + width > nav.clientWidth) break
          used += gap + width
          count++
        }
      }
      setVisible(count)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(nav)
    observer.observe(row)
    return () => observer.disconnect()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- children is the re-measure trigger: link widths are read from the rendered measurement row
  }, [children, linkCount, compactMobile])

  // A closed menu has no position; only an open one is measured below.
  if (!open && position) setPosition(null)
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const viewport = window.visualViewport
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8
      const topEdge = (viewport?.offsetTop ?? 0) + 8
      const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 16
      const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 16
      const width = Math.min(256, rightEdge - leftEdge)
      const below = bottomEdge - rect.bottom - 8
      const above = rect.top - topEdge - 8
      const height = Math.min(popup.current?.scrollHeight ?? 300, Math.max(below, above), 480)
      const top = below >= height ? rect.bottom + 8 : Math.max(topEdge, rect.top - 8 - height)
      setPosition({
        left: Math.max(leftEdge, Math.min(rect.right - width, rightEdge - width)),
        top,
        width,
        maxHeight: Math.max(48, Math.min(height, bottomEdge - top)),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [open])
  useLayoutEffect(() => {
    if (open && position && focusOnOpen.current) {
      focusOnOpen.current = false
      popupItems()[0]?.focus({ preventScroll: true })
    }
  }, [open, position, popupItems])
  if (useChanged(pathname, visible)) setOpen(false)
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (
        !container.current?.contains(event.target as Node) &&
        !popup.current?.contains(event.target as Node)
      )
        setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])

  const moreLabel = compactMobile ? (
    <>
      <span className="mobile-navigation-label">
        <span>{mobileLabel}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </span>
      <span className="desktop-navigation-label">
        More <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </>
  ) : (
    <>
      More <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
    </>
  )
  return (
    <nav
      ref={container}
      aria-label={label}
      className={`${compactMobile ? 'app-destinations ' : ''}header-navigation relative min-w-0 flex items-center gap-1 py-1.5 [&>a]:shrink-0 [&>button]:shrink-0`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setOpen(false)
          container.current?.querySelector<HTMLButtonElement>('button[aria-expanded]')?.focus()
        }
      }}
    >
      <div
        className="pointer-events-none invisible absolute inset-0 overflow-hidden"
        aria-hidden="true"
        inert
      >
        <div
          ref={measurements}
          className="flex w-max items-center gap-1 [&>a]:shrink-0 [&>button]:shrink-0"
        >
          {links}
          <button className="nav-link shrink-0" tabIndex={-1}>
            {moreLabel}
          </button>
        </div>
      </div>
      {links.slice(0, visible)}
      {visible < links.length && (
        <div className="relative shrink-0">
          <button
            ref={trigger}
            type="button"
            className="nav-link navigation-menu-toggle"
            aria-label={compactMobile ? 'Navigation' : undefined}
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => {
              focusOnOpen.current = !open
              setOpen(!open)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                focusOnOpen.current = true
                setOpen(true)
                if (open) popupItems()[0]?.focus({ preventScroll: true })
              }
            }}
          >
            {moreLabel}
          </button>
          {open &&
            createPortal(
              <div
                ref={popup}
                style={{ ...position, visibility: position ? 'visible' : 'hidden' }}
                id={menuId}
                className="fixed z-[80] overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1.5 shadow-xl [&>a]:flex [&>a]:w-full [&>a]:whitespace-normal [&>button]:flex [&>button]:w-full [&>button]:whitespace-normal"
                onClick={() => setOpen(false)}
                onKeyDown={(event) => {
                  if (event.key !== 'Tab') return
                  const items = popupItems()
                  if (event.shiftKey && document.activeElement === items[0]) {
                    event.preventDefault()
                    setOpen(false)
                    trigger.current?.focus({ preventScroll: true })
                  } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
                    // The portal lives at the end of body; continue after its trigger,
                    // rather than jumping out of the app or trapping focus in the popup.
                    const controls = Array.from(
                      document.querySelectorAll<HTMLElement>(
                        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
                      ),
                    ).filter(
                      (el) =>
                        el.tabIndex >= 0 &&
                        !el.closest('[inert]') &&
                        !popup.current?.contains(el) &&
                        el.getClientRects().length &&
                        getComputedStyle(el).visibility !== 'hidden',
                    )
                    const next = controls[controls.indexOf(trigger.current!) + 1]
                    if (next) {
                      event.preventDefault()
                      next.focus({ preventScroll: true })
                    }
                    setOpen(false)
                  }
                }}
                onBlur={(event) => {
                  if (
                    event.relatedTarget &&
                    !popup.current?.contains(event.relatedTarget as Node) &&
                    event.relatedTarget !== trigger.current
                  )
                    setOpen(false)
                }}
              >
                {links.slice(visible)}
                {mobileActions && <div className="mobile-navigation-actions">{mobileActions}</div>}
              </div>,
              document.body,
            )}
        </div>
      )}
    </nav>
  )
}
