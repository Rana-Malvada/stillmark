import { HttpError, integer } from '@/lib/http'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_FACES = 500

export function personId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!UUID.test(id)) throw new HttpError(400, 'Invalid person')
  return id
}
export function personName(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'Name is required')
  const name = value.replace(/\s+/g, ' ').trim()
  if (!name || name.length > 80) throw new HttpError(400, 'Names are 1-80 characters')
  if (/[\p{Cc}<>]/u.test(name)) throw new HttpError(400, 'Name contains invalid characters')
  return name
}
export function faceIds(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length) throw new HttpError(400, 'Choose at least one face')
  if (value.length > MAX_FACES) throw new HttpError(400, `At most ${MAX_FACES} faces at a time`)
  return [...new Set(value.map((v) => integer(v, 'face', 1, Number.MAX_SAFE_INTEGER)))]
}
/** A face box in 0-1 image coordinates, or null for a name-only tag. */
export function faceBox(value: unknown) {
  if (value == null) return null
  const box = value as Record<string, unknown>
  const [x, y, w, h] = ['x', 'y', 'w', 'h'].map((k) => Number(box[k]))
  if (
    ![x, y, w, h].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    w < 0.01 ||
    h < 0.01 ||
    x + w > 1 ||
    y + h > 1
  )
    throw new HttpError(400, 'Invalid face box')
  return { x, y, w, h }
}

export interface PeopleSettings {
  enabled: boolean
  shareNames: boolean
}

export interface PersonSummary {
  personId: string
  name: string | null
  hidden: boolean
  coverFaceId: number | null
  photoCount: number
  reviewCount: number
}

export interface FaceItem {
  qualityOk?: boolean
  faceId: number
  photoId: number
  eventId: number
  thumbnailPath: string | null
  hasCrop: boolean
  status: 'suggested' | 'auto' | 'confirmed' | null
  score: number | null
  source: 'detected' | 'manual'
  personId?: string | null
  personName?: string | null
}
