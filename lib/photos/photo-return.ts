/** Only photo routes may be used as a person's return destination. */
export function photoReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  return /^\/photos\/[1-9]\d*(?:\?[^#\\\s]*)?$/.test(value) ? value : null
}

export function photoInfoPath(
  photoId: number,
  context: string,
  expanded: boolean,
  faceId: number | null,
  scroll: number,
) {
  const params = new URLSearchParams(context)
  params.set('info', expanded ? 'expanded' : 'open')
  if (faceId !== null) params.set('face', String(faceId))
  params.set('infoScroll', String(Math.max(0, Math.round(scroll))))
  return `/photos/${photoId}?${params}`
}
