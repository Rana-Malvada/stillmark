'use client'

import { useId, useRef } from 'react'
import { Info } from 'lucide-react'
import { useDialogViewport } from './use-dialog-viewport'

export function CostExplanation({ title, explanation }: { title: string; explanation: string }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useDialogViewport(dialog)
  return (
    <>
      <button
        type="button"
        aria-label={`About ${title}`}
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Info size={16} aria-hidden="true" />
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        className="app-dialog m-auto w-[min(32rem,calc(100%-2rem))] overflow-hidden rounded-xl border bg-card text-foreground p-0"
      >
        <div className="flex items-center justify-between gap-3 border-b p-4">
          <h2 id={titleId} className="font-semibold">
            {title}
          </h2>
          <button
            type="button"
            className="control shrink-0"
            onClick={() => dialog.current?.close()}
          >
            Close
          </button>
        </div>
        <p className="min-h-0 overflow-y-auto p-4 text-sm leading-relaxed text-muted-foreground">
          {explanation}
        </p>
      </dialog>
    </>
  )
}
