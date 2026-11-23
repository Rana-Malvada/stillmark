'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, EyeOff, X } from 'lucide-react'
import { ClientResponseError } from '@/lib/client-response'
import { latestRequest } from '@/lib/latest-request'
import { type FaceBox, validFaceBox } from '@/lib/people/face-highlight'
import { type Face, FaceImage, peopleApi, PersonPicker } from './shared'

export interface PhotoFace extends Face {
  ignored?: boolean
  box?: FaceBox | null
}
interface PhotoPeople {
  canEdit: boolean
  faces: PhotoFace[]
  ignoredFaces?: PhotoFace[]
}

type WirePhotoFace = Omit<PhotoFace, 'photoId'> & { photoId?: number }
type WirePhotoPeople = Omit<PhotoPeople, 'faces' | 'ignoredFaces'> & {
  faces: WirePhotoFace[]
  ignoredFaces?: WirePhotoFace[]
}
function isPhotoPeople(value: unknown): value is WirePhotoPeople {
  if (!value || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  const optionalText = (text: unknown) => text == null || typeof text === 'string'
  const faces = (items: unknown) =>
    Array.isArray(items) &&
    items.every(
      (face) =>
        face &&
        typeof face === 'object' &&
        Number.isSafeInteger(face.faceId) &&
        (face.photoId === undefined || Number.isSafeInteger(face.photoId)) &&
        typeof face.hasCrop === 'boolean' &&
        optionalText(face.personId) &&
        optionalText(face.personName) &&
        (face.status == null || ['suggested', 'auto', 'confirmed'].includes(face.status)) &&
        (face.source === undefined || ['detected', 'manual'].includes(face.source)),
    )

  return (
    typeof data.canEdit === 'boolean' &&
    faces(data.faces) &&
    (data.ignoredFaces === undefined || faces(data.ignoredFaces))
  )
}

/** One authorized face response shared by the image overlay and Info panel. */
export function usePhotoPeople(photoId: number | null) {
  const [result, setResult] = useState<{ photoId: number; data: PhotoPeople } | null>(null)
  const [status, setStatus] = useState<{ photoId: number; loading: boolean; error: string } | null>(
    null,
  )
  const requests = useRef(latestRequest())
  const reload = useCallback(async () => {
    const request = requests.current.begin()
    if (photoId === null) return
    setStatus({ photoId, loading: true, error: '' })
    try {
      const data = await peopleApi<WirePhotoPeople>(
        `/api/photos/${photoId}/people`,
        'GET',
        undefined,
        request.signal,
        isPhotoPeople,
      )
      if (request.current()) {
        setResult({
          photoId,
          data: {
            ...data,
            // Shared viewers receive names without the owner-only face metadata.
            faces: data.faces.map((face) => ({ ...face, photoId })),
            ignoredFaces: data.ignoredFaces?.map((face) => ({ ...face, photoId })),
          },
        })
        setStatus({ photoId, loading: false, error: '' })
      }
    } catch (e) {
      if (!request.current()) return
      // Do not retain names or edit capabilities when access has been revoked.
      if (e instanceof ClientResponseError && [401, 403, 404].includes(e.status)) setResult(null)
      setStatus({
        photoId,
        loading: false,
        error: e instanceof Error ? e.message : 'Unable to load people. Please retry.',
      })
    }
  }, [photoId])
  useEffect(() => {
    const owner = requests.current
    // oxlint-disable-next-line react/set-state-in-effect -- reload marks its photo as loading; a revisited photo whose earlier status is still held must show loading again
    void reload()
    return () => owner.cancel()
  }, [reload])
  return {
    data: result?.photoId === photoId ? result.data : null,
    loading: photoId !== null && (status?.photoId !== photoId || status.loading),
    error: status?.photoId === photoId ? status.error : '',
    reload,
  }
}

/** People in the photo Info panel. Owners can correct; others see shared names only. */
export function PhotoPeoplePanel({
  photoId,
  readOnly,
  data,
  reload,
  loading = false,
  loadError = '',
  selectedFaceId,
  onSelectFace,
  returnToPhoto,
}: {
  photoId: number
  returnToPhoto?: string
  readOnly: boolean
  data: PhotoPeople | null
  loading?: boolean
  loadError?: string
  reload: () => Promise<void>
  selectedFaceId: number | null
  onSelectFace: (faceId: number) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tagging, setTagging] = useState(false)

  const personHref = (id: string | null | undefined) =>
    `/people/${id}${returnToPhoto ? `?returnTo=${encodeURIComponent(returnToPhoto)}` : ''}`
  const editable = !!data?.canEdit && !readOnly
  if (!loading && !loadError && (!data || (!data.faces.length && !editable))) return null

  async function change(action: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await action()
      await reload()
    } catch (e) {
      // A dropped acknowledgement does not prove the face correction failed.
      await reload().catch(() => {})
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }
  const icon = 'p-1 rounded hover:bg-foreground/15 disabled:opacity-40'

  return (
    <section className="mt-4 rounded-xl border border-border bg-foreground/[0.03] p-4">
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
        People
      </h4>
      {loading && (
        <p role="status" className="text-sm mb-2">
          Loading people…
        </p>
      )}
      {loadError && (
        <p role="alert" className="text-sm text-destructive mb-2">
          {loadError}{' '}
          <button
            type="button"
            className="control"
            disabled={loading || busy}
            onClick={() => void reload()}
          >
            Retry people
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive mb-2">
          {error}
        </p>
      )}
      {data?.faces.length === 0 && !loadError && (
        <p className="text-sm text-foreground/60 mb-2">No one found in this photo.</p>
      )}
      <ul className="space-y-2">
        {data?.faces.map((face) => {
          const named = face.personName && face.status !== 'suggested'
          return (
            <li key={face.faceId} className="flex flex-wrap items-center gap-2 text-sm">
              {face.source !== 'manual' && validFaceBox(face.box) ? (
                <button
                  type="button"
                  aria-label={`Highlight ${face.personName || 'face'} in photo`}
                  aria-pressed={selectedFaceId === face.faceId}
                  onClick={() => onSelectFace(face.faceId)}
                  className={`p-1 rounded-full focus-visible:outline-2 focus-visible:outline-primary ${selectedFaceId === face.faceId ? 'ring-2 ring-primary' : 'hover:bg-foreground/15'}`}
                >
                  <FaceImage faceId={face.faceId} hasCrop={face.hasCrop} className="w-9 h-9" />
                </button>
              ) : (
                <FaceImage faceId={face.faceId} hasCrop={face.hasCrop} className="w-9 h-9" />
              )}
              <span className="flex-1 min-w-0">
                {named ? (
                  <Link
                    href={editable ? personHref(face.personId) : `/search?person=${face.personId}`}
                    className="hover:underline truncate block"
                  >
                    {face.personName}
                  </Link>
                ) : face.status === 'suggested' ? (
                  <span className="block truncate">
                    {face.personName ?? 'Unnamed'}?
                    <span className="text-foreground/50"> Possible match</span>
                  </span>
                ) : face.personId ? (
                  <Link
                    href={personHref(face.personId)}
                    className="hover:underline text-foreground/70"
                  >
                    Unnamed group
                  </Link>
                ) : (
                  <span className="text-foreground/60">Unknown</span>
                )}
              </span>
              {editable && face.status === 'suggested' && (
                <button
                  type="button"
                  className={icon}
                  disabled={busy || loading || !!loadError}
                  aria-label={`Confirm ${face.personName ?? 'match'}`}
                  onClick={() =>
                    change(() =>
                      peopleApi(`/api/people/${face.personId}/faces`, 'POST', {
                        action: 'confirm',
                        faceIds: [face.faceId],
                      }),
                    )
                  }
                >
                  <Check className="w-4 h-4" />
                </button>
              )}
              {editable && face.personId && (
                <button
                  type="button"
                  className={icon}
                  disabled={busy || loading || !!loadError}
                  aria-label="Not this person"
                  title="Not this person"
                  onClick={() =>
                    change(() =>
                      peopleApi(`/api/people/${face.personId}/faces`, 'POST', {
                        action: 'reject',
                        faceIds: [face.faceId],
                      }),
                    )
                  }
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              {editable && (
                <button
                  type="button"
                  className={icon}
                  disabled={busy || loading || !!loadError}
                  aria-label="Ignore this face"
                  title="Ignore this face"
                  onClick={() =>
                    change(() =>
                      peopleApi('/api/people/ignore', 'POST', {
                        faceIds: [face.faceId],
                        ignored: true,
                      }),
                    )
                  }
                >
                  <EyeOff className="w-4 h-4" />
                </button>
              )}
              {editable && !named && (
                <span className="basis-full pl-11 [&_input]:bg-foreground/10 [&_input]:border-border [&_input]:text-foreground">
                  <PersonPicker
                    disabled={busy || loading || !!loadError}
                    label="Name"
                    onPick={(target) =>
                      change(() =>
                        peopleApi('/api/people/assign', 'POST', {
                          faceIds: [face.faceId],
                          ...target,
                        }),
                      )
                    }
                  />
                </span>
              )}
            </li>
          )
        })}
      </ul>
      {editable &&
        (tagging ? (
          <div className="mt-3 [&_input]:bg-foreground/10 [&_input]:border-border [&_input]:text-foreground">
            <p className="text-xs text-foreground/60 mb-1">Tag someone the scanner missed</p>
            <PersonPicker
              disabled={busy || loading || !!loadError}
              label="Tag"
              onPick={(target) =>
                change(async () => {
                  await peopleApi(`/api/photos/${photoId}/people`, 'POST', target)
                  setTagging(false)
                })
              }
            />
          </div>
        ) : (
          <button
            type="button"
            disabled={loading || !!loadError}
            className="mt-3 text-xs underline text-foreground/70"
            onClick={() => setTagging(true)}
          >
            Tag someone
          </button>
        ))}
    </section>
  )
}
