'use client'
import { useDialogViewport } from './use-dialog-viewport'
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from './auth-provider'
import { browserUploadStorage } from '@/lib/upload/upload-storage'
import { isBatchUploading, UploadQueue } from '@/lib/upload/upload-queue'
import { uploadDismissDestination } from '@/lib/upload/upload-dismiss'
import { UploadReview } from './upload-review'
import { UploadProgressList } from './upload-progress'

const Context = createContext<UploadQueue | null>(null)
export function useUploads() {
  const queue = useContext(Context)
  if (!queue) throw new Error('UploadProvider missing')
  const batches = useSyncExternalStore(queue.subscribe, queue.snapshot, queue.snapshot)
  return { queue, batches }
}
function UploadStatus() {
  const router = useRouter()
  const dismissPending = useRef(false)
  const [dismissing, setDismissing] = useState(false)
  const { queue, batches } = useUploads()
  const { username } = useAuth()
  const dialog = useRef<HTMLDialogElement>(null)
  useDialogViewport(dialog)
  const scrollContainer = useRef<HTMLDivElement>(null)
  const latestId = batches.at(-1)?.id
  useEffect(() => {
    if (latestId && !dialog.current?.open) dialog.current?.showModal()
  }, [latestId])
  const active = batches.some(isBatchUploading)
  const needsOriginals = batches.some(
    (b) => !b.needsFiles && b.files.some((f) => !['success', 'skipped'].includes(f.phase)),
  )
  useEffect(() => {
    if (!needsOriginals) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [needsOriginals])
  if (!batches.length) return null
  const files = batches.flatMap((b) => b.files)
  const done = files.filter((f) => ['success', 'skipped'].includes(f.phase)).length
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
        className="upload-status-trigger fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-40 rounded-full border border-border bg-card px-5 py-3 text-sm font-medium shadow-lg"
      >
        {active
          ? 'Uploading'
          : files.some((f) => f.phase === 'failed')
            ? 'Uploads need attention'
            : 'Uploads finished'}{' '}
        · {done}/{files.length} complete
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="upload-dialog-title"
        className="upload-dialog app-dialog fixed inset-0 m-auto w-[calc(100%_-_2rem)] max-w-2xl max-h-[85dvh] overflow-hidden rounded-2xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-scrim/50"
      >
        <div className="shrink-0 flex items-center justify-between gap-3 p-4 border-b">
          <h2 id="upload-dialog-title" className="text-lg font-semibold">
            Upload progress{' '}
            <span className="block text-sm text-muted-foreground">
              {done} / {files.length} complete
            </span>
          </h2>
          <button type="button" onClick={() => dialog.current?.close()} className="control">
            {active ? 'Minimize' : 'Close'}
          </button>
        </div>
        <div
          ref={scrollContainer}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 dialog-footer [scrollbar-gutter:stable]"
        >
          <p className="text-xs text-muted-foreground mb-4">
            Minimize to browse while uploads continue. Upload progress is saved in this browser.
            After reopening, reselect the original files or folder to resume. Completed files are
            skipped.
          </p>
          <div className="space-y-4">
            {batches.map((batch) => (
              <section key={batch.id} className="space-y-2">
                <div className="upload-actions flex flex-wrap gap-1 items-center text-sm">
                  <strong className="break-all">{batch.label}</strong>
                  {batch.eventId && (
                    <Link
                      onClick={() => dialog.current?.close()}
                      className="underline"
                      href={`/events/${batch.eventId}`}
                    >
                      View album
                    </Link>
                  )}
                  {batch.running && (
                    <button
                      onClick={() => queue.cancel(batch.id)}
                      disabled={batch.cancelling}
                      className="underline disabled:opacity-50"
                    >
                      {batch.cancelling ? 'Cancelling…' : 'Cancel upload'}
                    </button>
                  )}
                  {batch.accessIssue === 'authentication' && (
                    <a
                      href="/auth/start"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      Sign in in a new tab
                    </a>
                  )}
                  {!batch.running && batch.needsFiles && (
                    <>
                      <label className="underline cursor-pointer">
                        Reselect files
                        <input
                          type="file"
                          multiple
                          className="sr-only"
                          onChange={(e) => {
                            queue.reselect(batch.id, Array.from(e.target.files ?? []))
                            e.target.value = ''
                          }}
                        />
                      </label>
                      <label className="underline cursor-pointer">
                        Reselect folder
                        <input
                          type="file"
                          multiple
                          {...{ webkitdirectory: '' }}
                          className="sr-only"
                          onChange={(e) => {
                            queue.reselect(batch.id, Array.from(e.target.files ?? []))
                            e.target.value = ''
                          }}
                        />
                      </label>
                    </>
                  )}
                  {!batch.running &&
                    !batch.needsFiles &&
                    batch.files.some((f) => f.phase === 'failed') && (
                      <button
                        onClick={() =>
                          batch.accessIssue
                            ? void queue.resume(batch.id, username)
                            : queue.retry(batch.id)
                        }
                        className="underline"
                      >
                        {batch.accessIssue
                          ? 'Check access and resume'
                          : batch.recovered
                            ? 'Resume upload'
                            : 'Retry failed files'}
                      </button>
                    )}
                  {!batch.running && (
                    <button
                      disabled={dismissing}
                      onClick={async () => {
                        if (dismissPending.current) return
                        dismissPending.current = true
                        setDismissing(true)
                        const startPath = window.location.pathname
                        try {
                          const destination = await uploadDismissDestination(batch.eventId)
                          queue.dismiss(batch.id)
                          dialog.current?.close()
                          if (destination && window.location.pathname === startPath)
                            router.push(destination)
                        } finally {
                          dismissPending.current = false
                          setDismissing(false)
                        }
                      }}
                      className="underline"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
                {batch.warning && (
                  <p role="alert" className="text-sm text-warning">
                    {batch.warning}
                  </p>
                )}
                <UploadProgressList files={batch.files} scrollContainer={scrollContainer} />
                {!batch.running && (
                  <UploadReview
                    batch={batch}
                    retry={() =>
                      batch.accessIssue
                        ? void queue.resume(batch.id, username)
                        : queue.retry(batch.id)
                    }
                    close={() => dialog.current?.close()}
                  />
                )}
              </section>
            ))}
          </div>
        </div>
      </dialog>
    </>
  )
}
function UploadProviderSession({
  children,
  owner,
}: {
  children: React.ReactNode
  owner: string | null
}) {
  const router = useRouter()
  const [queue] = useState(
    () =>
      new UploadQueue(
        undefined,
        (eventId) => {
          window.dispatchEvent(new CustomEvent('gallery-upload-complete', { detail: eventId }))
          router.refresh()
        },
        owner ? browserUploadStorage(owner) : undefined,
      ),
  )
  useEffect(() => queue.activate(), [queue])
  return (
    <Context.Provider value={queue}>
      <UploadStatus />
      {children}
    </Context.Provider>
  )
}

export function UploadProvider({ children }: { children: React.ReactNode }) {
  const { username, canManagePersonal } = useAuth()
  return (
    <UploadProviderSession key={username ?? 'pending'} owner={canManagePersonal ? username : null}>
      {children}
    </UploadProviderSession>
  )
}
