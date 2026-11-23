'use client'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Ellipsis } from 'lucide-react'

export function ViewerActionsMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node) && !document.querySelector('dialog[open]'))
        setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return (
    <div
      ref={root}
      className="relative"
      onPointerLeave={(e) => {
        if (
          e.pointerType === 'mouse' &&
          !root.current?.contains(document.activeElement) &&
          !document.querySelector('dialog[open]')
        )
          setOpen(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
          e.stopPropagation()
          setOpen(false)
          trigger.current?.focus()
        }
      }}
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false)
      }}
    >
      <button
        ref={trigger}
        aria-label="More actions"
        title="More actions"
        aria-expanded={open}
        aria-controls="viewer-more-actions"
        className="p-2 text-foreground/70 hover:text-foreground"
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') setOpen(true)
        }}
        onClick={(e) => {
          if (e.detail > 0 && window.matchMedia('(hover: hover)').matches) setOpen(true)
          else setOpen((v) => !v)
        }}
      >
        <Ellipsis className="h-5 w-5" />
      </button>
      <div hidden={!open} id="viewer-more-actions" className="viewer-actions-popover dark">
        <div className="viewer-action-items">{children}</div>
      </div>
    </div>
  )
}
