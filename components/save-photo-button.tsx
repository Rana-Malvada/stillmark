'use client'
import { useEffect, useRef, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { loadOriginal } from '@/lib/original-transfer'
import { useClientValue } from './use-client-value'

const isMobileDevice = () =>
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export function SavePhotoButton({
  url,
  filename,
  isVideo = false,
}: {
  url: string | null
  filename: string
  isVideo?: boolean
}) {
  const mobile = useClientValue(isMobileDevice, false)
  const [busy, setBusy] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [supported, setSupported] = useState(true)
  const dialog = useRef<HTMLDialogElement>(null)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the reset must follow the previous photo's abort in this effect, or its late prepared file could attach to this photo
    setBusy(false)
    setFile(null)
    setError('')
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- holds the newest transfer, not a DOM node: cleanup must abort the live one
    return () => controller.current?.abort()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- url and filename identify the photo; a different photo must drop the prepared file
  }, [url, filename])
  const mediaName = isVideo ? 'video' : 'photo'
  const download = () => {
    if (url)
      window.open(
        url + (url.includes('?') ? '&' : '?') + 'download=1',
        '_blank',
        'noopener,noreferrer',
      )
  }
  async function share(prepared: File) {
    const request = controller.current
    setError('')
    try {
      await navigator.share({ files: [prepared] })
      if (controller.current !== request || request?.signal.aborted) return
      dialog.current?.close()
      setFile(null)
    } catch (e) {
      if (controller.current !== request || request?.signal.aborted) return
      if (e instanceof Error && e.name === 'AbortError') return
      setError('Tap Save or share again to open your phone’s sharing options.')
    }
  }
  async function prepare() {
    if (!url) return
    if (!mobile) {
      download()
      return
    }
    dialog.current?.showModal()
    setError('')
    setFile(null)
    if (!navigator.share || !navigator.canShare) {
      setSupported(false)
      return
    }
    setSupported(true)
    setBusy(true)
    controller.current?.abort()
    const c = new AbortController()
    controller.current = c
    try {
      const blob = await loadOriginal(
        url + (url.includes('?') ? '&' : '?') + 'download=1',
        c.signal,
      )
      if (controller.current !== c || c.signal.aborted) return
      if (!blob.type.startsWith(isVideo ? 'video/' : 'image/'))
        throw Error(`The server did not return a ${mediaName}. Please sign in again and retry.`)
      const prepared = new File([blob], filename, { type: blob.type })
      if (!navigator.canShare({ files: [prepared] })) {
        setSupported(false)
        return
      }
      setFile(prepared)
      // Slow downloads can exhaust Safari’s user activation. Keep a fresh-tap action available.
      if (navigator.userActivation?.isActive) void share(prepared)
    } catch (e) {
      if (!c.signal.aborted)
        setError(e instanceof Error ? e.message : `Unable to prepare ${mediaName}`)
    } finally {
      if (!c.signal.aborted) setBusy(false)
    }
  }
  return (
    <>
      <button
        aria-label={mobile ? `Save ${mediaName}` : 'Download original'}
        title={mobile ? `Save ${mediaName}` : 'Download original'}
        disabled={!url || busy}
        onClick={() => void prepare()}
        className="p-2 text-foreground/70 hover:text-foreground disabled:opacity-50 transition-colors"
      >
        <Download className="w-5 h-5" />
      </button>
      <dialog
        ref={dialog}
        onClose={() => {
          controller.current?.abort()
          setBusy(false)
          setFile(null)
        }}
        className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-xl border border-border bg-muted text-foreground p-5 backdrop:bg-scrim/70"
        aria-labelledby="save-photo-title"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="save-photo-title" className="font-semibold">
            Save {mediaName}
          </h2>
          <button className="control" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </div>
        <p className="my-3 text-sm text-foreground/75">
          On iPhone or iPad, choose {isVideo ? 'Save Video' : 'Save Image'} in the sharing options.
          On Android, choose a Photos, Gallery, or save option if offered by your phone.
        </p>
        {busy && (
          <p role="status" className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Preparing original {mediaName}… Keep this page open.
          </p>
        )}
        {error && (
          <p role="alert" className="my-3 text-destructive">
            {error}
          </p>
        )}
        {file && (
          <button className="primary-button" onClick={() => void share(file)}>
            Save or share
          </button>
        )}
        {!supported && (
          <p className="text-sm my-3">
            This browser cannot share this {mediaName} file.{' '}
            {isVideo
              ? 'Use Download file to save it to Files or Downloads, then open it there to move it to Photos or Gallery.'
              : 'Open the image, then touch and hold it for your browser’s save options.'}
          </p>
        )}
        {!busy && (
          <div className="flex flex-wrap gap-3 mt-4">
            {!file && supported && (
              <button className="control" onClick={() => void prepare()}>
                Try again
              </button>
            )}
            <a
              className="control"
              href={url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open {mediaName}
            </a>
            <button className="control" onClick={download}>
              Download file
            </button>
          </div>
        )}
      </dialog>
    </>
  )
}
