'use client'
import { clientMutation, clientOperation } from '@/lib/client-operation'
import { isOk, isReviewPhotos } from '@/lib/frontend-response-contracts'
import { useEffect, useEffectEvent, useState } from 'react'
import Link from 'next/link'
import type { UploadBatch } from '@/lib/upload/upload-queue'
import { type ReviewPhoto, uploadReview } from '@/lib/upload/upload-review'
import { AlbumLocation } from './album-location'

function DateFix({
  photo,
  onSaved,
  close,
}: {
  photo: ReviewPhoto
  onSaved: () => void
  close: () => void
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <form
      className="flex flex-wrap gap-2 items-center"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError('')
        try {
          await clientMutation(
            `/api/photos/${photo.photoId}/date`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dateTaken: new Date(value + 'Z').toISOString() }),
            },
            'Unable to save date',
            isOk,
            onSaved,
          )
          onSaved()
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Unable to save date')
        } finally {
          setBusy(false)
        }
      }}
    >
      <Link onClick={close} className="underline break-all" href={`/photos/${photo.photoId}`}>
        {photo.sourceFilename}
      </Link>
      <label className="text-xs">
        Capture date/time (UTC)
        <input
          required
          type="datetime-local"
          className="control block max-w-full"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
        />
      </label>
      <button className="control" disabled={busy || !value}>
        {busy ? 'Saving…' : 'Save date'}
      </button>
      {error && (
        <p role="alert" className="w-full text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}
export function UploadReview({
  batch,
  retry,
  close,
}: {
  batch: UploadBatch
  retry: () => void
  close: () => void
}) {
  const [photos, setPhotos] = useState<ReviewPhoto[] | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  // Read when a review starts; upload progress alone must not restart the review.
  const uploadedIds = useEffectEvent(() => [
    ...new Set(
      batch.files
        .filter((f) => f.phase === 'success' || f.phase === 'skipped')
        .map((f) => f.photoId)
        .filter((id): id is number => id != null),
    ),
  ])
  useEffect(() => {
    if (!batch.eventId) return
    const c = new AbortController()
    // oxlint-disable-next-line react/set-state-in-effect -- the clear must follow the previous review's abort in this effect, or its late failure would stay on screen (a success never clears the error)
    setError('')
    const ids = uploadedIds()
    void (async () => {
      const photos: ReviewPhoto[] = []
      for (let start = 0; start < ids.length; start += 200) {
        const rows = await clientOperation<ReviewPhoto[]>(
          `/api/events/${batch.eventId}/review?ids=${encodeURIComponent(ids.slice(start, start + 200).join(','))}`,
          { cache: 'no-store', signal: c.signal },
          'Unable to load metadata review. Use Refresh review to retry.',
          isReviewPhotos,
        )
        photos.push(...rows)
      }
      if (!c.signal.aborted) setPhotos(photos)
    })().catch((e) => {
      if (!c.signal.aborted) setError(e.message)
    })
    return () => c.abort()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- revision is the Refresh review trigger
  }, [batch.eventId, revision])
  const review = uploadReview(batch.files, photos ?? [])
  return (
    <section
      aria-label="Upload review"
      className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3 text-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Upload review</h3>
        <button className="underline" onClick={() => setRevision((v) => v + 1)}>
          Refresh review
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Review this upload before dismissing it. Missing metadata does not prevent viewing photos.
        Original files stay unchanged.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {batch.eventId && !photos && !error && <p role="status">Checking saved metadata…</p>}
      {photos && (
        <>
          <p className="text-xs text-muted-foreground">
            {review.checked} saved files checked · Missing dates use capture dates, even if the
            album has a year.
          </p>
          <details>
            <summary className="cursor-pointer font-medium">
              Missing capture dates · {review.missingDates.length}
            </summary>
            <div className="mt-3 max-h-72 overflow-auto space-y-4">
              {review.missingDates.length ? (
                review.missingDates.map((p) => (
                  <DateFix
                    key={p.photoId}
                    photo={p}
                    close={close}
                    onSaved={() => setRevision((v) => v + 1)}
                  />
                ))
              ) : (
                <p>All checked files have capture dates.</p>
              )}
            </div>
          </details>
          <details>
            <summary className="cursor-pointer font-medium">
              Missing GPS · {review.missingGps.length}
            </summary>
            <div className="mt-3 space-y-3">
              {!!review.missingGps.length && batch.eventId && (
                <>
                  <p className="text-xs text-muted-foreground">
                    Set an approximate location for photos without GPS. This tool applies to all
                    photos missing GPS in this album; it shows the total before confirmation. Videos
                    are listed here but are not changed by this tool. Refresh review after saving.
                  </p>
                  <AlbumLocation eventId={batch.eventId} canEdit />
                </>
              )}
              <ul className="max-h-48 overflow-auto">
                {review.missingGps.map((p) => (
                  <li key={p.photoId}>
                    <Link
                      onClick={close}
                      className="underline break-all"
                      href={`/photos/${p.photoId}`}
                    >
                      {p.sourceFilename}
                    </Link>
                  </li>
                ))}
              </ul>
              {!review.missingGps.length && <p>All checked files have saved coordinates.</p>}
            </div>
          </details>
        </>
      )}
      <details>
        <summary className="cursor-pointer font-medium">
          Duplicates skipped · {review.duplicates.length}
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">
          These files were already in this album and were not added again. This does not detect
          visually similar photos.
        </p>
        <ul className="max-h-48 overflow-auto mt-2">
          {review.duplicates.map((f, i) => (
            <li key={i} className="break-all">
              {f.filename} ·{' '}
              <Link onClick={close} className="underline" href={`/photos/${f.photoId}`}>
                View existing photo
              </Link>
            </li>
          ))}
        </ul>
      </details>
      <details open={review.failed.length > 0}>
        <summary className="cursor-pointer font-medium">
          Failed files · {review.failed.length}
        </summary>
        {!!review.failed.length && (
          <div className="mt-2 space-y-2">
            {batch.needsFiles ? (
              <p>
                Use Reselect files or Reselect folder above to resume. Completed files are skipped.
              </p>
            ) : (
              <button className="control" onClick={retry}>
                Retry failed files
              </button>
            )}
            <ul className="max-h-48 overflow-auto space-y-2">
              {review.failed.map((f, i) => (
                <li key={i} className="break-all">
                  {f.filename}
                  <p className="text-xs text-destructive">{f.error || 'Upload failed'}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </details>
    </section>
  )
}
