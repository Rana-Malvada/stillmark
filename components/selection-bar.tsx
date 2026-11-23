'use client'

import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

/** Always mounted above its grid, so selecting never moves the content below it. */
export function SelectionBar({
  label,
  summary,
  children,
  actionsVisible = true,
  auxiliaryPanel,
}: {
  label: string
  summary: ReactNode
  children: ReactNode
  actionsVisible?: boolean
  auxiliaryPanel?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  if (!actionsVisible && open) setOpen(false)
  const panelId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!toolbar.current?.contains(event.target as Node)) setOpen(false)
    }
    const focusOutside = (event: FocusEvent) => {
      if (!toolbar.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.querySelector('dialog[open]')
      )
        return
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', escape)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', focusOutside)
    return () => {
      document.removeEventListener('keydown', escape)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', focusOutside)
    }
  }, [open])
  const toolbar = useRef<HTMLElement>(null)
  useEffect(() => {
    const header = document.querySelector('.app-header')
    if (!header) return
    const update = () =>
      toolbar.current?.style.setProperty(
        '--selection-header-height',
        `${header.getBoundingClientRect().height}px`,
      )
    const observer = new ResizeObserver(update)
    observer.observe(header)
    update()
    return () => observer.disconnect()
  }, [])
  return (
    <section ref={toolbar} aria-label={label} className="selection-toolbar">
      <div className="selection-toolbar-row">
        <div className="selection-toolbar-summary" onClick={() => setOpen(false)}>
          {summary}
        </div>
        {actionsVisible && (
          <button
            ref={trigger}
            type="button"
            className="control selection-actions-toggle"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen(!open)}
          >
            Actions <ChevronDown size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {auxiliaryPanel}
      <div id={panelId} hidden={!open || !actionsVisible} className="selection-actions-panel">
        {children}
      </div>
    </section>
  )
}
