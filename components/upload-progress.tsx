'use client'
import { useDialogViewport } from './use-dialog-viewport'
import { memo, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { uploadRowOffsets, uploadSummary, uploadWindow } from '@/lib/upload/upload-progress-summary'

import type { FileProgress } from '@/lib/upload/upload-response'

export type { FileProgress } from '@/lib/upload/upload-response'

export const UploadProgressList = memo(function UploadProgressList({
  files,
  scrollContainer,
}: {
  scrollContainer?: RefObject<HTMLElement | null>
  files: FileProgress[]
}) {
  const summary = useMemo(() => uploadSummary(files), [files])
  const offsets = useMemo(() => uploadRowOffsets(files), [files])
  const { finished, percent } = summary
  const list = useRef<HTMLUListElement>(null)
  const errorDialog = useRef<HTMLDialogElement>(null)
  useDialogViewport(errorDialog)
  const [errorFile, setErrorFile] = useState<FileProgress | null>(null)
  const [viewportHeight, setViewportHeight] = useState(256)
  const [scrollTop, setScrollTop] = useState(0)
  useEffect(() => {
    const parent = scrollContainer?.current
    if (!parent) return
    const update = () => {
      if (!list.current) return
      setScrollTop(
        Math.max(0, parent.getBoundingClientRect().top - list.current.getBoundingClientRect().top),
      )
      setViewportHeight(parent.clientHeight)
    }
    const observer = new ResizeObserver(update)
    observer.observe(parent)
    parent.addEventListener('scroll', update, { passive: true })
    update()
    return () => {
      observer.disconnect()
      parent.removeEventListener('scroll', update)
    }
  }, [scrollContainer])
  const window = uploadWindow(scrollTop, files.length, viewportHeight, offsets)
  const latest = useRef(summary)
  // Declared before the rate effect so the sampler always starts from this render's totals.
  useEffect(() => {
    latest.current = summary
  })
  const [rate, setRate] = useState(0)
  if (!summary.active && rate !== 0) setRate(0)
  useEffect(() => {
    if (!summary.active) return
    let previous = latest.current.transferred
    let time = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      const current = latest.current
      setRate(
        current.active ? Math.max(0, current.transferred - previous) / ((now - time) / 1000) : 0,
      )
      previous = current.transferred
      time = now
    }, 2000)
    return () => clearInterval(timer)
  }, [summary.active])
  if (!files.length) return null
  const labels = {
    waiting: 'Waiting',
    uploading: 'Uploading',
    processing: 'Processing',
    success: 'Uploaded',
    skipped: 'Already in album',
    failed: 'Failed',
  }
  return (
    <section
      aria-label="Upload progress"
      className="w-full min-w-0 rounded-xl border border-border bg-card p-4 space-y-3 text-sm"
    >
      <div className="flex justify-between items-start gap-3 tabular-nums" role="status">
        <div>
          <p className="font-medium">Upload progress</p>
          <p className="text-xs text-muted-foreground">
            {finished} / {files.length} complete
          </p>
        </div>
        <span>{percent}%</span>
      </div>
      <dl className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs tabular-nums">
        {[
          ['Transferring', summary.transferring],
          ['Queued', summary.queued],
          ['Processing', summary.processing],
          ['Completed', finished],
          ['Waiting', summary.waiting],
          ['Failed', summary.failedCount],
        ].map(([label, count]) => (
          <div key={label} className="min-w-0">
            <dt className="text-muted-foreground truncate">{label}</dt>
            <dd>{count}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        Accepted files finish on the server. Processing status updates every five seconds.
      </p>
      <UploadBar label="Overall upload progress" value={percent} className="h-2" />
      <dl className="grid grid-cols-3 gap-2 text-xs tabular-nums">
        <div>
          <dt className="text-muted-foreground">Remaining</dt>
          <dd>{summary.known ? (summary.remaining / 1024 / 1024).toFixed(1) + ' MiB' : '—'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Transfer speed</dt>
          <dd>{rate > 0 ? (rate / 1024 / 1024).toFixed(2) + ' MiB/s' : '—'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Transfer time</dt>
          <dd>{rate > 0 ? '~' + Math.ceil(summary.remaining / rate / 60) + ' min' : '—'}</dd>
        </div>
      </dl>
      <ul
        ref={list}
        className={scrollContainer ? '' : 'h-64 overflow-y-auto'}
        onScroll={scrollContainer ? undefined : (e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <li aria-hidden="true" style={{ height: window.before }} />
        {files.slice(window.start, window.end).map((file, offset) => (
          <li
            key={window.start + offset}
            aria-posinset={window.start + offset + 1}
            aria-setsize={files.length}
            className="relative space-y-1 overflow-hidden"
            style={{
              height: offsets[window.start + offset + 1] - offsets[window.start + offset],
              paddingBottom: 8,
            }}
          >
            <div className="flex justify-between gap-3 text-xs">
              <span className="truncate" title={file.filename}>
                {file.filename}
              </span>
              {file.phase === 'failed' && file.error ? (
                <button
                  aria-label={`View upload error for ${file.filename}: ${file.error}`}
                  className="shrink-0 text-destructive underline"
                  onClick={() => {
                    setErrorFile(file)
                    errorDialog.current?.showModal()
                  }}
                >
                  Failed · Details
                </button>
              ) : file.phase === 'skipped' && file.photoId ? (
                <a
                  href={`/photos/${file.photoId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Already uploaded as ${file.existingFilename || 'this photo'}`}
                  className="shrink-0 text-muted-foreground underline"
                >
                  Already in album
                </a>
              ) : (
                <span className="shrink-0 text-muted-foreground">
                  {file.skipReason === 'metadata'
                    ? 'Ignored metadata'
                    : file.serverQueued && file.phase === 'processing'
                      ? file.queueState === 'queued'
                        ? 'Uploaded · queued'
                        : file.queueState === 'processing'
                          ? 'Uploaded · processing'
                          : 'Uploaded · checking status'
                      : labels[file.phase]}
                  {file.phase === 'uploading' ? ` ${Math.floor(file.percent)}%` : ''}
                </span>
              )}
            </div>
            <UploadBar
              label={`Upload progress for ${file.filename}`}
              value={file.percent}
              className="h-1.5"
              failed={file.phase === 'failed'}
            />
          </li>
        ))}
        <li aria-hidden="true" style={{ height: window.after }} />
      </ul>
      <dialog
        ref={errorDialog}
        aria-label="Upload error details"
        className="app-dialog m-auto w-[min(30rem,calc(100%-2rem))] max-h-[80dvh] p-0 border rounded-xl bg-card text-foreground backdrop:bg-scrim/60"
      >
        <div className="flex justify-between items-center gap-2 p-4 border-b">
          <h3 className="font-semibold">Upload error</h3>
          <button className="control" onClick={() => errorDialog.current?.close()}>
            Close
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-4 space-y-3">
          <p className="break-all">{errorFile?.filename}</p>
          <p className="break-words">{errorFile?.error}</p>
        </div>
      </dialog>
    </section>
  )
})

function UploadBar({
  label,
  value,
  className,
  failed = false,
}: {
  label: string
  value: number
  className: string
  failed?: boolean
}) {
  const percent = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={`w-full overflow-hidden rounded-full bg-muted ${className}`}
    >
      <div
        className={`h-full w-full origin-left rounded-full transition-transform duration-150 ease-linear motion-reduce:transition-none ${failed ? 'bg-destructive' : 'bg-primary'}`}
        style={{ transform: `scaleX(${percent / 100})` }}
      />
    </div>
  )
}
