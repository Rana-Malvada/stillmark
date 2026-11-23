'use client'
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { toggleCostType } from '@/lib/costs/cost-chart-selection'

export function CostChartFilter({
  selected,
  services,
  onChange,
}: {
  selected: string[]
  services: { key: string; label: string }[]
  onChange: (selected: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return (
    <div
      ref={root}
      className="relative w-full sm:w-auto"
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          setOpen(false)
          trigger.current?.focus()
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="control flex w-full items-center justify-between gap-2 text-xs !px-3 !py-2 sm:w-auto"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        Cost types · {selected.length ? `${selected.length} selected` : 'Total cost'}
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0" />
      </button>
      {open && (
        <div
          id={id}
          className="absolute right-0 top-full z-30 mt-1 w-full max-w-[calc(100vw-2.5rem)] rounded-lg border bg-card p-2 shadow-xl sm:w-64"
        >
          <div
            role="group"
            aria-label="Cost types shown on chart"
            className="max-h-[min(60dvh,24rem)] overflow-y-auto overscroll-contain"
          >
            <button
              type="button"
              className="control mb-1 w-full !min-h-11 sm:!min-h-8 !px-2 !py-1.5 !text-xs text-left aria-pressed:bg-primary aria-pressed:text-primary-foreground"
              aria-pressed={selected.length === 0}
              onClick={() => onChange([])}
            >
              All · Total cost
            </button>
            {services.map((service) => (
              <label
                key={service.key}
                className="flex min-h-11 sm:min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-muted"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-primary"
                  checked={selected.includes(service.key)}
                  onChange={() => onChange(toggleCostType(selected, service.key))}
                />
                {service.label}
              </label>
            ))}
          </div>
          <button
            type="button"
            className="control mt-1 w-full !min-h-11 sm:!min-h-8 !px-2 !py-1.5 !text-xs"
            onClick={() => {
              setOpen(false)
              trigger.current?.focus()
            }}
          >
            Done
          </button>
        </div>
      )}
    </div>
  )
}
