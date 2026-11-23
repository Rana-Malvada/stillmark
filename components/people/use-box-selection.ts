'use client'
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import { intersectsSelection, selectionBox, type SelectionBox } from '@/lib/selection-box'

/** Preview locally while dragging so the bulk toolbar cannot move the grid mid-gesture. */
export function useBoxSelection<T extends number | string>(
  available: T[],
  selected: Set<T>,
  onSelect?: (ids: T[]) => void,
  limit = Infinity,
) {
  const root = useRef<HTMLDivElement>(null)
  const cleanup = useRef<(() => void) | null>(null)
  const suppressClick = useRef(false)
  const [preview, setPreview] = useState<Set<T> | null>(null)
  const [box, setBox] = useState<SelectionBox | null>(null)
  useEffect(() => () => cleanup.current?.(), [])
  // Selection switched off mid-drag: drop the preview now; the effect removes the listeners.
  if (!onSelect && (preview || box)) {
    setPreview(null)
    setBox(null)
  }
  useEffect(() => {
    if (!onSelect) cleanup.current?.()
  }, [onSelect])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    suppressClick.current = false
    if (!onSelect || event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary) return
    if ((event.target as Element).closest('label,input,button,select,textarea')) return
    const ids = new Map(available.map((id) => [String(id), id]))
    const element = root.current!
    cleanup.current?.()
    const bounds = element.getBoundingClientRect()
    const origin = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    let pointer = { x: event.clientX, y: event.clientY }
    const initial = { ...pointer }
    const baseline = new Set(selected)
    let next = new Set(baseline)
    let dragging = false
    const pointerId = event.pointerId
    const draw = () => {
      const rect = element.getBoundingClientRect()
      const area = selectionBox(origin, {
        x: Math.max(0, Math.min(rect.width, pointer.x - rect.left)),
        y: Math.max(0, Math.min(rect.height, pointer.y - rect.top)),
      })
      next = new Set(baseline)
      for (const tile of element.querySelectorAll<HTMLElement>('[data-selection-id]')) {
        const target = tile.getBoundingClientRect()
        if (
          intersectsSelection(area, {
            left: target.left - rect.left,
            top: target.top - rect.top,
            width: target.width,
            height: target.height,
          })
        ) {
          const id = ids.get(tile.dataset.selectionId!)
          if (id !== undefined && next.size < limit) next.add(id)
        }
      }
      setBox(area)
      setPreview(next)
    }
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      pointer = { x: e.clientX, y: e.clientY }
      if (!dragging && Math.hypot(pointer.x - initial.x, pointer.y - initial.y) < 6) return
      dragging = true
      suppressClick.current = true
      e.preventDefault()
      draw()
    }
    const finish = (commit: boolean) => {
      cleanup.current?.()
      setBox(null)
      setPreview(null)
      if (dragging && commit) onSelect([...next])
    }
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      if (dragging) {
        pointer = { x: e.clientX, y: e.clientY }
        draw()
      }
      finish(true)
    }
    const cancel = () => finish(false)
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      }
    }
    const scroll = () => {
      if (dragging) draw()
    }
    document.addEventListener('pointermove', move, { passive: false })
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', cancel)
    document.addEventListener('keydown', key)
    window.addEventListener('blur', cancel)
    window.addEventListener('scroll', scroll, true)
    cleanup.current = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointercancel', cancel)
      document.removeEventListener('keydown', key)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('scroll', scroll, true)
      cleanup.current = null
    }
  }
  /** Swallows the click that ends a drag so it does not open the tile underneath. */
  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (suppressClick.current && event.detail !== 0) {
      event.preventDefault()
      event.stopPropagation()
      suppressClick.current = false
    }
  }
  return { root, preview, box, onPointerDown, onClickCapture }
}
