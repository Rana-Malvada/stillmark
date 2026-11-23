'use client'
import { useId, useState } from 'react'

export interface AllowanceRequest {
  uploads: number
  bytes: number
  aiSearches: number
}
const GIB = 1073741824

/** Validates the three allowance fields exactly as the server does. */
export function parseAllowance(
  uploads: string,
  gib: string,
  aiSearches: string,
): AllowanceRequest | string {
  const files = Number(uploads)
  const storage = Number(gib)
  const searches = Number(aiSearches)
  if (!uploads.trim() || !Number.isSafeInteger(files) || files < 0 || files > 1000000)
    return 'Enter a file allowance from 0 to 1,000,000.'
  if (!gib.trim() || !Number.isFinite(storage) || storage < 0 || storage > 10240)
    return 'Enter a storage allowance from 0 to 10,240 GiB.'
  if (!aiSearches.trim() || !Number.isSafeInteger(searches) || searches < 0 || searches > 10000)
    return 'Enter a daily AI search allowance from 0 to 10,000.'
  return { uploads: files, bytes: Math.floor(storage * GIB), aiSearches: searches }
}

/** Inline replacement for browser prompts: nothing is sent until Save allowance. */
export function AllowanceForm({
  busy,
  onSave,
}: {
  busy: boolean
  onSave: (request: AllowanceRequest) => Promise<void>
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [uploads, setUploads] = useState('')
  const [gib, setGib] = useState('')
  const [aiSearches, setAiSearches] = useState('0')
  const [problem, setProblem] = useState('')
  const field = 'control w-full !text-sm'
  return (
    <div className="space-y-3">
      <button
        type="button"
        className="control"
        disabled={busy}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(true)}
      >
        Set upload allowance
      </button>
      {open && (
        <form
          id={id}
          className="grid gap-3 sm:grid-cols-3"
          aria-label="Upload allowance"
          onSubmit={async (event) => {
            event.preventDefault()
            const request = parseAllowance(uploads, gib, aiSearches)
            if (typeof request === 'string') {
              setProblem(request)
              return
            }
            setProblem('')
            await onSave(request)
          }}
        >
          <label className="grid gap-1 text-sm">
            Total files
            <input
              className={field}
              type="number"
              inputMode="numeric"
              min={0}
              max={1000000}
              step={1}
              required
              value={uploads}
              disabled={busy}
              onChange={(event) => setUploads(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Total storage (GiB)
            <input
              className={field}
              type="number"
              inputMode="decimal"
              min={0}
              max={10240}
              step="any"
              required
              value={gib}
              disabled={busy}
              onChange={(event) => setGib(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            AI searches per day
            <input
              className={field}
              type="number"
              inputMode="numeric"
              min={0}
              max={10000}
              step={1}
              required
              value={aiSearches}
              disabled={busy}
              onChange={(event) => setAiSearches(event.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground sm:col-span-3">
            Totals include uploads already used. Failed and cancelled uploads count.
          </p>
          {problem && (
            <p role="alert" className="text-sm text-destructive sm:col-span-3">
              {problem}
            </p>
          )}
          <div className="flex flex-wrap gap-2 sm:col-span-3">
            <button className="primary-button" disabled={busy}>
              Save allowance
            </button>
            <button
              type="button"
              className="control"
              disabled={busy}
              onClick={() => {
                setOpen(false)
                setProblem('')
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
