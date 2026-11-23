import { photoSorts } from '../gallery-query'
import { HttpError, textValue } from '@/lib/http'

export function photoFilters(params: URLSearchParams) {
  const sort = params.get('sort') || 'oldest'
  if (!Object.hasOwn(photoSorts, sort)) throw new HttpError(400, 'Invalid sort')
  const { key, descending } = photoSorts[sort as keyof typeof photoSorts]
  const media = params.get('media') || ''
  if (!['', 'photo', 'video'].includes(media)) throw new HttpError(400, 'Invalid media type')
  const date = (key: string) => {
    const v = params.get(key)
    if (!v) return null
    if (
      v.startsWith('0000') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
      !Number.isFinite(Date.parse(v)) ||
      new Date(v).toISOString().slice(0, 10) !== v
    )
      throw new HttpError(400, 'Invalid date')
    return v
  }
  const from = date('from')
  const to = date('to')
  if (from && to && from > to) throw new HttpError(400, 'Start date must precede end date')
  const value = (key: string) => (params.get(key) ? textValue(params.get(key), key, 200) : null)
  const favorite = params.get('favorite') || ''
  if (!['', 'true'].includes(favorite)) throw new HttpError(400, 'Invalid favorites filter')
  return {
    sort,
    key,
    descending,
    media: media || null,
    favorite: favorite === 'true',
    from,
    to,
    camera: value('camera'),
    location: value('location'),
  }
}
