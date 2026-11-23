'use client'
import { type ReactNode, useEffect, useRef, useState } from 'react'

export function visibleRows(
  count: number,
  columns: number,
  width: number,
  top: number,
  height: number,
  gap = 0,
) {
  const stride = (width - (columns - 1) * gap) / columns + gap
  const rows = Math.ceil(count / columns)
  const start = Math.min(Math.max(0, rows - 1), Math.max(0, Math.floor(top / stride) - 3))
  return {
    stride,
    rows,
    start,
    end: Math.min(rows, Math.max(start + 1, Math.ceil((top + height) / stride) + 3)),
  }
}
export function VirtualPhotoGrid<T>({
  items,
  render,
  enabled = true,
}: {
  items: T[]
  render: (item: T) => ReactNode
  enabled?: boolean
}) {
  const root = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ columns: 3, gap: 0, width: 0, top: 0, height: 800 })
  const [focused, setFocused] = useState<number | null>(null)
  useEffect(() => {
    const element = root.current
    if (!element) return
    let frame = 0
    const measure = () => {
      const r = element.getBoundingClientRect()
      setView({
        columns: Number(getComputedStyle(element).getPropertyValue('--photo-columns')) || 3,
        gap: parseFloat(getComputedStyle(element).getPropertyValue('--photo-gap')) || 0,
        width: r.width,
        top: -r.top,
        height: window.innerHeight,
      })
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    measure()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [])
  const range = visibleRows(
    items.length,
    view.columns,
    view.width || 360,
    view.top,
    view.height,
    view.gap,
  )
  const rows = new Set(Array.from({ length: range.end - range.start }, (_, i) => range.start + i))
  if (focused !== null && focused < range.rows) rows.add(focused)
  return (
    <div ref={root} className="relative photo-grid">
      {!enabled ? (
        <div className="photo-grid-layout">{items.map(render)}</div>
      ) : (
        <div style={{ height: Math.max(0, range.rows * range.stride - view.gap) }}>
          {[...rows]
            .sort((a, b) => a - b)
            .map((row) => (
              <div
                key={row}
                className="absolute left-0 right-0 photo-grid-layout"
                style={{
                  top: row * range.stride,
                }}
                onFocusCapture={() => setFocused(row)}
                onBlurCapture={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(null)
                }}
              >
                {items.slice(row * view.columns, (row + 1) * view.columns).map(render)}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
